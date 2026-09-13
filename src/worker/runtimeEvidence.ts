export interface RuntimeDependencyStatus {
  available: boolean;
  detail: string;
  status?: "retryable" | "unavailable";
}

function credentialEnvironmentForProvider(provider: string): string | undefined {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "google_tts") return "GOOGLE_TTS_API_KEY";
  if (provider === "freesound") return "FREESOUND_API_KEY";
  return undefined;
}

export function credentialEnvironmentForReference(provider: string, adapter: string | undefined, credentialRef: string | undefined): string | undefined {
  if (isConnectionId(credentialRef) || adapter) return undefined;
  return credentialEnvironmentForProvider(provider);
}

export function runtimeCommandArguments(command: string): string[] {
  if (command === (process.env.WHISPERX_PYTHON?.trim() || "python3")) return ["-c", "import whisperx, torch; print('whisperx local runtime available')"];
  return command === "ffmpeg" ? ["-version"] : ["--version"];
}

export function runtimeCommandInvocation(command: string, argumentsList: string[], options: { openChatCutNode?: string } = {}): { command: string; argumentsList: string[] } {
  if (command === "openchatcut") return { command: options.openChatCutNode ?? process.env.OPENCHATCUT_NODE ?? process.execPath, argumentsList: ["scripts/openchatcut-render.mjs", ...argumentsList] };
  return { command, argumentsList };
}

function isConnectionId(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}
