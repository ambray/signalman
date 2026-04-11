/**
 * Docker integration barrel file.
 *
 * Re-exports the Docker client, compose builder, and related types.
 */

export {
  DockerClient,
  type ContainerConfig,
  type ContainerStatus,
  type ComposeConfig,
} from "./client.js";

export {
  ComposeBuilder,
  type ComposeService,
  type ComposeSpec,
} from "./compose-builder.js";
