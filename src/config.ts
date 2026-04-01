import * as dotenv from "dotenv";

// Load variables from .env into process.env
dotenv.config();

class Settings {
  public readonly openSearchUrl: string;
  public readonly indexName: string;
  public readonly embeddingModelName: string;

  public readonly useLocalLlm: boolean;

  // Local LLM Config
  public readonly localLlmUrl?: string;
  public readonly localLlmModelName?: string;

  // AWS Config
  public readonly awsProfileName?: string;
  public readonly awsRegion?: string;
  public readonly awsModelId?: string;

  public readonly linearTeam: string;

  constructor() {
    this.openSearchUrl = Settings.getEnvVar("OPENSEARCH_URL");
    this.indexName = Settings.getEnvVar("INDEX_NAME");
    this.embeddingModelName = Settings.getEnvVar("EMBEDDING_MODEL_NAME");

    this.linearTeam = Settings.getEnvVar("LINEAR_TEAM");

    const useLocalLlmStr =
      Settings.getEnvVar("USE_LOCAL_LLM", false) || "false";
    this.useLocalLlm = ["true", "1", "yes", "y"].includes(
      useLocalLlmStr.toLowerCase(),
    );

    if (this.useLocalLlm) {
      this.localLlmUrl = Settings.getEnvVar("LOCAL_LLM_URL");
      this.localLlmModelName = Settings.getEnvVar("LOCAL_LLM_MODEL_NAME");
      return; // Skip AWS config
    }

    this.awsProfileName = Settings.getEnvVar("AWS_PROFILE", false); // Optional
    this.awsRegion = Settings.getEnvVar("AWS_REGION", false) || "us-east-1"; // Fallback
    this.awsModelId = Settings.getEnvVar("AWS_MODEL_ID");
  }

  /**
   * Helper to safely fetch environment variables.
   * Guaranteed to return a string if required=true, eliminating TypeScript 'undefined' errors.
   */
  private static getEnvVar(name: string, required: boolean = true): string {
    const value = process.env[name];
    if (!value && required) {
      throw new Error(
        `EnvironmentError: Required variable ${name} is not set.`,
      );
    }
    return value || "";
  }

  public toDict(): Record<string, any> {
    return {
      openSearchUrl: this.openSearchUrl,
      indexName: this.indexName,
      embeddingModelName: this.embeddingModelName,
      useLocalLlm: this.useLocalLlm,
      localLlmUrl: this.useLocalLlm
        ? this.localLlmUrl
        : "Skipped: USE_LOCAL_LLM is false",
      localLlmModelName: this.useLocalLlm
        ? this.localLlmModelName
        : "Skipped: USE_LOCAL_LLM is false",
      awsProfileName: !this.useLocalLlm
        ? this.awsProfileName
        : "Skipped: USE_LOCAL_LLM is true",
      awsRegion: !this.useLocalLlm
        ? this.awsRegion
        : "Skipped: USE_LOCAL_LLM is true",
      awsModelId: !this.useLocalLlm
        ? this.awsModelId
        : "Skipped: USE_LOCAL_LLM is true",
    };
  }
}

// Instantiate exactly once (Singleton pattern) and export it
export const config = new Settings();
