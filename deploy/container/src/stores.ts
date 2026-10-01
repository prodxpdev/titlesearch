// The cache store for the container's platform.

import { MemoryStore } from "@titlesearch/cache";
import { DynamoDbStore, ecsCredentials, envCredentials } from "@titlesearch/cache/dynamodb";
import { FirestoreStore, metadataServerToken } from "@titlesearch/cache/firestore";
import type { BlobStore, CacheStore } from "@titlesearch/core";
import type { ContainerEnv } from "./config.js";

export function createStore(
  c: ContainerEnv,
  env: Record<string, string | undefined>,
): CacheStore & BlobStore {
  switch (c.CACHE_BACKEND) {
    case "firestore":
      return new FirestoreStore({
        projectId: c.GOOGLE_CLOUD_PROJECT as string,
        databaseId: c.FIRESTORE_DATABASE,
        accessToken: metadataServerToken(),
      });
    case "dynamodb": {
      const ecs = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
      return new DynamoDbStore({
        table: c.DYNAMODB_TABLE as string,
        region: c.AWS_REGION as string,
        // Lambda puts credentials in the environment; ECS serves them from the task-role endpoint.
        credentials: ecs ? ecsCredentials(ecs) : envCredentials(env),
      });
    }
    case "memory":
      return new MemoryStore();
  }
}
