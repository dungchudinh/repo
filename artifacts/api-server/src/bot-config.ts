import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./lib/logger";

const CONFIG_PATH = join(process.cwd(), "bot-config.json");

interface BotConfig {
  spamMessage: string;
}

const DEFAULT_CONFIG: BotConfig = {
  spamMessage: "con tuat chui vào bụng mẹ trốn à 😂",
};

function loadConfig(): BotConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<BotConfig>) };
    }
  } catch (err) {
    logger.warn({ err }, "Failed to read bot-config.json, using defaults");
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: BotConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to save bot-config.json");
  }
}

// Singleton in-memory config (loaded once at startup)
let config = loadConfig();

export function getSpamMessage(): string {
  return config.spamMessage;
}

export function setSpamMessage(newMessage: string): void {
  config.spamMessage = newMessage;
  saveConfig(config);
}
