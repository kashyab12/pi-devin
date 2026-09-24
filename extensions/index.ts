import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

type Runtime = {
  authStatus: typeof import("../src/credentials.ts").authStatus;
  loginWithCli: typeof import("../src/credentials.ts").loginWithCli;
  readActiveCredentials: typeof import("../src/credentials.ts").readActiveCredentials;
  whichDevin: typeof import("../src/cli.ts").whichDevin;
  devinVersion: typeof import("../src/cli.ts").devinVersion;
  FALLBACK_MODELS: typeof import("../src/models.ts").FALLBACK_MODELS;
  loadCliCatalog: typeof import("../src/models.ts").loadCliCatalog;
  modelsFromCatalog: typeof import("../src/models.ts").modelsFromCatalog;
  CLIENT_IDE: typeof import("../src/metadata.ts").CLIENT_IDE;
  CLIENT_VERSION: typeof import("../src/metadata.ts").CLIENT_VERSION;
  streamDevin: typeof import("../src/stream.ts").streamDevin;
};

let runtime: Runtime | undefined;

const PROVIDER_ID = "devin";
const API_ID = "devin-local";
const LOCAL_AUTH_MARKER = "devin-cli";
const PLACEHOLDER_BASE_URL = "https://server.codeium.com";

let _pi: ExtensionAPI | null = null;

async function loadRuntime(): Promise<Runtime> {
  if (!runtime) {
    const [credentials, cli, models, metadata, stream] = await Promise.all([
      import("../src/credentials.ts"),
      import("../src/cli.ts"),
      import("../src/models.ts"),
      import("../src/metadata.ts"),
      import("../src/stream.ts"),
    ]);
    runtime = { ...credentials, ...cli, ...models, ...metadata, ...stream };
  }
  return runtime;
}

async function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): Promise<void> {
  const { loginWithCli, readActiveCredentials, loadCliCatalog, modelsFromCatalog, streamDevin } = await loadRuntime();
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin Local",
    api: API_ID,
    apiKey: LOCAL_AUTH_MARKER,
    baseUrl: PLACEHOLDER_BASE_URL,
    models,
    oauth: {
      name: "Devin CLI",
      async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const creds = await loginWithCli();
        if (_pi) {
          try {
            const catalog = await loadCliCatalog();
            await registerDevinProvider(_pi, modelsFromCatalog(catalog));
          } catch {
            // keep current models
          }
        }
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const creds = readActiveCredentials();
        if (!creds) return credentials;
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return readActiveCredentials()?.apiKey || credentials.access;
      },
      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  const { loadCliCatalog, modelsFromCatalog, readActiveCredentials, authStatus, whichDevin, devinVersion, CLIENT_IDE, CLIENT_VERSION, FALLBACK_MODELS } = await loadRuntime();
  await registerDevinProvider(pi, FALLBACK_MODELS);

  try {
    if (readActiveCredentials()) {
      const catalog = await loadCliCatalog();
      await registerDevinProvider(pi, modelsFromCatalog(catalog));
    }
  } catch {
    // fallback models already registered
  }

  pi.on("session_start", async () => {
    try {
      if (!_pi || !readActiveCredentials()) return;
      const catalog = await loadCliCatalog();
      await registerDevinProvider(_pi, modelsFromCatalog(catalog));
    } catch {
      // keep current models
    }
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin CLI auth + binary status",
    handler: async (_args, ctx) => {
      const bin = await whichDevin();
      const version = await devinVersion();
      const status = await authStatus();
      ctx.ui.notify(
        [
          bin ? `CLI: ${bin}` : "CLI: not found",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          status.loggedIn ? "Auth: signed in via Devin CLI" : "Auth: not signed in. Run /login devin or `devin auth login`",
        ].join("\n"),
        status.loggedIn && bin ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh Devin Local model catalog from `devin models list`",
    handler: async (_args, ctx) => {
      try {
        const catalog = await loadCliCatalog();
        const models = modelsFromCatalog(catalog);
        await registerDevinProvider(pi, models);
        ctx.ui.notify(`Devin: loaded ${models.length} families from the local CLI.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
