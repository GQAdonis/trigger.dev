import { $, type ExecaChildProcess, execa } from "execa";
import {
  SimpleLogger,
  TaskOperations,
  ProviderShell,
  TaskOperationsRestoreOptions,
  TaskOperationsCreateOptions,
  TaskOperationsIndexOptions,
} from "@trigger.dev/core-apps";
import { setTimeout } from "node:timers/promises";
import { PostStartCauses, PreStopCauses } from "@trigger.dev/core/v3";

const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 8020;
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";

const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://0.0.0.0:4318";

const FORCE_CHECKPOINT_SIMULATION = ["1", "true"].includes(
  process.env.FORCE_CHECKPOINT_SIMULATION ?? "true"
);

const logger = new SimpleLogger(`[${MACHINE_NAME}]`);

type InitializeReturn = {
  canCheckpoint: boolean;
  willSimulate: boolean;
};

function isExecaChildProcess(maybeExeca: unknown): maybeExeca is Awaited<ExecaChildProcess> {
  return typeof maybeExeca === "object" && maybeExeca !== null && "escapedCommand" in maybeExeca;
}

class DockerTaskOperations implements TaskOperations {
  #initialized = false;
  #canCheckpoint = false;

  constructor(private opts = { forceSimulate: false }) {}

  async #initialize(): Promise<InitializeReturn> {
    if (this.#initialized) {
      return this.#getInitializeReturn();
    }

    logger.log("Initializing task operations");

    if (this.opts.forceSimulate) {
      logger.log("Forced simulation enabled. Will simulate regardless of checkpoint support.");
    }

    try {
      await $`criu --version`;
    } catch (error) {
      logger.error("No checkpoint support: Missing CRIU binary. Will simulate instead.");
      this.#canCheckpoint = false;
      this.#initialized = true;

      return this.#getInitializeReturn();
    }

    try {
      await $`docker checkpoint`;
    } catch (error) {
      logger.error("No checkpoint support: Docker needs to have experimental features enabled");
      logger.error("Will simulate instead");
      this.#canCheckpoint = false;
      this.#initialized = true;

      return this.#getInitializeReturn();
    }

    logger.log("Full checkpoint support!");

    this.#initialized = true;
    this.#canCheckpoint = true;

    return this.#getInitializeReturn();
  }

  #getInitializeReturn(): InitializeReturn {
    return {
      canCheckpoint: this.#canCheckpoint,
      willSimulate: !this.#canCheckpoint || this.opts.forceSimulate,
    };
  }

  async index(opts: TaskOperationsIndexOptions) {
    await this.#initialize();

    const containerName = this.#getIndexContainerName(opts.shortCode);

    logger.log(`Indexing task ${opts.imageRef}`, {
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    try {
      logger.debug(
        await execa("docker", [
          "run",
          "--network=host",
          "--rm",
          `--env=INDEX_TASKS=true`,
          `--env=TRIGGER_SECRET_KEY=${opts.apiKey}`,
          `--env=TRIGGER_API_URL=${opts.apiUrl}`,
          `--env=TRIGGER_ENV_ID=${opts.envId}`,
          `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}`,
          `--env=POD_NAME=${containerName}`,
          `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
          `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
          `--name=${containerName}`,
          `${opts.imageRef}`,
        ])
      );
    } catch (error: any) {
      if (!isExecaChildProcess(error)) {
        throw error;
      }

      logger.error("Index failed:", {
        opts,
        exitCode: error.exitCode,
        escapedCommand: error.escapedCommand,
        stdout: error.stdout,
        stderr: error.stderr,
      });
    }
  }

  async create(opts: TaskOperationsCreateOptions) {
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.runId);

    try {
      logger.debug(
        await execa("docker", [
          "run",
          "--network=host",
          "--detach",
          `--env=TRIGGER_ENV_ID=${opts.envId}`,
          `--env=TRIGGER_RUN_ID=${opts.runId}`,
          `--env=OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}`,
          `--env=POD_NAME=${containerName}`,
          `--env=COORDINATOR_HOST=${COORDINATOR_HOST}`,
          `--env=COORDINATOR_PORT=${COORDINATOR_PORT}`,
          `--name=${containerName}`,
          `${opts.image}`,
        ])
      );
    } catch (error) {
      if (!isExecaChildProcess(error)) {
        throw error;
      }

      logger.error("Create failed:", {
        opts,
        exitCode: error.exitCode,
        escapedCommand: error.escapedCommand,
        stdout: error.stdout,
        stderr: error.stderr,
      });
    }
  }

  async restore(opts: TaskOperationsRestoreOptions) {
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.runId);

    if (!this.#canCheckpoint || this.opts.forceSimulate) {
      logger.log("Simulating restore");

      const unpause = logger.debug(await $`docker unpause ${containerName}`);

      if (unpause.exitCode !== 0) {
        throw new Error("docker unpause command failed");
      }

      await this.#sendPostStart(containerName);
      return;
    }

    const { exitCode } = logger.debug(
      await $`docker start --checkpoint=${opts.checkpointRef} ${containerName}`
    );

    if (exitCode !== 0) {
      throw new Error("docker start command failed");
    }

    await this.#sendPostStart(containerName);
  }

  async delete(opts: { runId: string }) {
    await this.#initialize();

    const containerName = this.#getRunContainerName(opts.runId);
    await this.#sendPreStop(containerName);

    logger.log("noop: delete");
  }

  async get(opts: { runId: string }) {
    await this.#initialize();

    logger.log("noop: get");
  }

  #getIndexContainerName(suffix: string) {
    return `task-index-${suffix}`;
  }

  #getRunContainerName(suffix: string) {
    return `task-run-${suffix}`;
  }

  async #sendPostStart(containerName: string): Promise<void> {
    try {
      const port = await this.#getHttpServerPort(containerName);
      logger.debug(await this.#runLifecycleCommand(containerName, port, "postStart", "restore"));
    } catch (error) {
      logger.error("postStart error", { error });
      throw new Error("postStart command failed");
    }
  }

  async #sendPreStop(containerName: string): Promise<void> {
    try {
      const port = await this.#getHttpServerPort(containerName);
      logger.debug(await this.#runLifecycleCommand(containerName, port, "preStop", "terminate"));
    } catch (error) {
      logger.error("preStop error", { error });
      throw new Error("preStop command failed");
    }
  }

  async #getHttpServerPort(containerName: string): Promise<number> {
    // We first get the correct port, which is random during dev as we run with host networking and need to avoid clashes
    // FIXME: Skip this in prod
    const logs = logger.debug(await $`docker logs ${containerName}`);
    const matches = logs.stdout.match(/http server listening on port (?<port>[0-9]+)/);

    const port = Number(matches?.groups?.port);

    if (!port) {
      throw new Error("failed to extract port from logs");
    }

    return port;
  }

  async #runLifecycleCommand<THookType extends "postStart" | "preStop">(
    containerName: string,
    port: number,
    type: THookType,
    cause: THookType extends "postStart" ? PostStartCauses : PreStopCauses,
    retryCount = 0
  ): Promise<ExecaChildProcess> {
    try {
      return await execa("docker", [
        "exec",
        containerName,
        "busybox",
        "wget",
        "-q",
        "-O-",
        `127.0.0.1:${port}/${type}?cause=${cause}`,
      ]);
    } catch (error: any) {
      if (type === "postStart" && retryCount < 6) {
        logger.debug(`retriable ${type} error`, { retryCount, message: error?.message });
        await setTimeout(exponentialBackoff(retryCount + 1, 2, 50, 1150, 50));

        return this.#runLifecycleCommand(containerName, port, type, cause, retryCount + 1);
      }

      logger.error(`final ${type} error`, { message: error?.message });
      throw new Error(`${type} command failed after ${retryCount - 1} retries`);
    }
  }
}

const provider = new ProviderShell({
  tasks: new DockerTaskOperations({ forceSimulate: FORCE_CHECKPOINT_SIMULATION }),
  type: "docker",
});

provider.listen();

function exponentialBackoff(
  retryCount: number,
  exponential: number,
  minDelay: number,
  maxDelay: number,
  jitter: number
): number {
  // Calculate the delay using the exponential backoff formula
  const delay = Math.min(Math.pow(exponential, retryCount) * minDelay, maxDelay);

  // Calculate the jitter
  const jitterValue = Math.random() * jitter;

  // Return the calculated delay with jitter
  return delay + jitterValue;
}
