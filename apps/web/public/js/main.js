import { readConfig } from "./config.js";
import { createApp } from "./ui/app.js";

createApp({ doc: document, win: window, config: readConfig(document) });
