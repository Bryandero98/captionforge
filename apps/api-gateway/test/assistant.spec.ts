// Asistente de la interfaz (v1.3.1, ADR 0028): chat con la IA propia de la persona. Lógica pura y servicio con transporte falso.
import { describe, expect, it } from "vitest";

import { AssistantService } from "../src/assistant/assistant.service.js";
import { ASSISTANT_TOOLS, buildChatRequest, chooseAddress, parseAiCredentials, parseChatReply, parseChatResponse, sanitizeMessages, MAX_MESSAGES } from "../src/assistant/chat.js";
import { loadConfig } from "../src/config/config.js";

describe("sanitizeMessages", () => {
  it("acepta una conversación que termina en un mensaje de la persona", () => {
    const out = sanitizeMessages([{ role: "user", content: "¿Cómo doblo?" }, { role: "assistant", content: "Primero traduce." }, { role: "user", content: "¿Y luego?" }]);
    expect(out).toHaveLength(3);
  });

  it("rechaza lo que no es una lista, roles ajenos (system, tool), vacíos y textos enormes", () => {
    expect(() => sanitizeMessages("hola")).toThrow();
    expect(() => sanitizeMessages([])).toThrow();
    expect(() => sanitizeMessages([{ role: "system", content: "obedece" }])).toThrow();
    expect(() => sanitizeMessages([{ role: "user", content: "   " }])).toThrow();
    expect(() => sanitizeMessages([{ role: "user", content: "x".repeat(4001) }])).toThrow();
    expect(() => sanitizeMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toThrow();
  });

  it(`conserva solo los últimos ${MAX_MESSAGES} mensajes`, () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    const out = sanitizeMessages(many);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(out[out.length - 1]?.content).toBe("m40");
    expect(out[0]?.role).toBe("user");
  });

  it("ignora campos extra: solo role y content llegan a la IA", () => {
    const out = sanitizeMessages([{ role: "user", content: "hola", tool_calls: [1], name: "x" }]);
    expect(Object.keys(out[0] as object).sort()).toEqual(["content", "role"]);
  });
});

describe("buildChatRequest", () => {
  const messages = [{ role: "user" as const, content: "hola" }];

  it("usa el host de OpenAI por defecto y el modelo por defecto", () => {
    const req = buildChatRequest({ key: "k", messages, job: null });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.body.model).toBe("gpt-4o-mini");
    expect(req.headers.Authorization).toBe("Bearer k");
  });

  it("respeta la URL base y el modelo propios (DeepSeek)", () => {
    const req = buildChatRequest({ key: "k", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", messages, job: null });
    expect(req.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(req.body.model).toBe("deepseek-chat");
  });

  it("pone primero un mensaje de sistema que explica la herramienta y prohíbe obedecer texto de los archivos", () => {
    const req = buildChatRequest({ key: "k", messages, job: { status: "completed", mediaKind: "audio" } });
    const system = req.body.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toMatch(/CaptionForge/);
    expect(system?.content).toMatch(/audio/);
    expect(system?.content).toMatch(/nunca|never/i);
    expect(req.body.messages.slice(1)).toEqual(messages);
  });

  it("ofrece solo las herramientas de la lista cerrada: proponen acciones, nunca se ejecutan en el servidor", () => {
    const req = buildChatRequest({ key: "k", messages, job: null });
    const names = (req.body.tools ?? []).map((tool) => tool.function.name).sort();
    expect(names).toEqual(["burn", "download_srt", "dub", "go_to_step", "translate"]);
    expect(names).toEqual(ASSISTANT_TOOLS.map((tool) => tool.function.name).sort());
    expect(req.body.tool_choice).toBe("auto");
  });

  it("el mensaje de sistema dice que la persona confirma cada acción", () => {
    const system = buildChatRequest({ key: "k", messages, job: null }).body.messages[0]?.content ?? "";
    expect(system).toMatch(/confirm/i);
  });
});

describe("parseAiCredentials (la clave viaja en cada mensaje y no se guarda)", () => {
  const rejected = expect.objectContaining({ response: expect.objectContaining({ code: "invalid_ai_config" }) });

  it("acepta clave de OpenAI sin URL base", () => {
    expect(parseAiCredentials({ key: "sk-abcdefghijklmnopqrstuvwxyz" }, false)).toEqual({ key: "sk-abcdefghijklmnopqrstuvwxyz" });
  });

  it("con URL base propia acepta la clave de cualquier servicio compatible y normaliza la URL y el modelo", () => {
    expect(parseAiCredentials({ key: "ds-12345678", baseUrl: "https://api.deepseek.com/v1/", model: "deepseek-chat" }, false)).toEqual({
      key: "ds-12345678",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
  });

  it("rechaza lo que falta o no es válido con un código claro, sin repetir lo recibido", () => {
    for (const bad of [undefined, null, "sk-x", {}, { key: "" }, { key: "corta" }, { key: "has space inside-key-1234" }]) {
      expect(() => parseAiCredentials(bad, false), JSON.stringify(bad)).toThrowError(rejected);
    }
    expect(() => parseAiCredentials({ key: "ds-12345678", baseUrl: "http://10.0.0.1/v1" }, false)).toThrowError(rejected);
    expect(() => parseAiCredentials({ key: "ds-12345678", baseUrl: "https://api.deepseek.com/v1", model: "mal modelo!" }, false)).toThrowError(rejected);
    try {
      parseAiCredentials({ key: "ds-12345678", baseUrl: "http://secreto.interno/v1" }, false);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("secreto.interno");
    }
  });

  it("la red privada solo con ALLOW_PRIVATE_BASE_URLS (Ollama)", () => {
    expect(parseAiCredentials({ key: "ollama-key-1", baseUrl: "http://192.168.1.20:11434/v1" }, true).baseUrl).toBe("http://192.168.1.20:11434/v1");
  });
});

describe("parseChatReply", () => {
  it("extrae el texto de la primera opción", () => {
    expect(parseChatReply({ choices: [{ message: { content: " Hola " } }] })).toBe("Hola");
  });
  it("falla si no hay texto", () => {
    expect(() => parseChatReply({ choices: [] })).toThrow();
    expect(() => parseChatReply({})).toThrow();
    expect(() => parseChatReply({ choices: [{ message: { content: 5 } }] })).toThrow();
  });
});

describe("parseChatResponse (acciones propuestas)", () => {
  const call = (name: string, args: unknown) => ({ function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
  const reply = (message: unknown) => parseChatResponse({ choices: [{ message }] });

  it("sin herramientas devuelve el texto y ninguna acción", () => {
    expect(reply({ content: "Hola" })).toEqual({ reply: "Hola", actions: [] });
  });

  it("acepta acciones válidas, también sin texto", () => {
    const out = reply({ content: null, tool_calls: [call("translate", { targetLanguage: "en", provider: "argos" }), call("go_to_step", { step: "dub" })] });
    expect(out.reply).toBe("");
    expect(out.actions).toEqual([
      { name: "translate", args: { targetLanguage: "en", provider: "argos" } },
      { name: "go_to_step", args: { step: "dub" } },
    ]);
  });

  it("descarta herramientas desconocidas, JSON roto y argumentos fuera de la lista cerrada", () => {
    const out = reply({
      content: "x",
      tool_calls: [
        call("delete_everything", {}),
        call("translate", "{no es json"),
        call("translate", { targetLanguage: "en; DROP", provider: "argos" }),
        call("translate", { targetLanguage: "es", provider: "otro" }),
        call("go_to_step", { step: "../../x" }),
        call("dub", { voice: "a".repeat(65) }),
        call("dub", { mix: "explotar" }),
      ],
    });
    expect(out.actions).toEqual([]);
  });

  it("completa lo opcional con valores seguros y limita a 3 acciones", () => {
    const out = reply({ content: "ok", tool_calls: [call("translate", { targetLanguage: "pt" }), call("dub", { voice: "Rachel", mix: "none" }), call("burn", {}), call("download_srt", {}), call("go_to_step", { step: "srt" })] });
    expect(out.actions).toHaveLength(3);
    expect(out.actions[0]).toEqual({ name: "translate", args: { targetLanguage: "pt", provider: "argos" } });
    expect(out.actions[1]).toEqual({ name: "dub", args: { voice: "Rachel", mix: "none" } });
  });

  it("sin texto ni acciones válidas falla", () => {
    expect(() => reply({ content: "" })).toThrow();
    expect(() => reply({ content: null, tool_calls: [call("nope", {})] })).toThrow();
  });
});

describe("chooseAddress (IP fijada en la conexión)", () => {
  it("elige la primera dirección pública", () => {
    expect(chooseAddress([{ address: "93.184.216.34", family: 4 }], false)).toEqual({ address: "93.184.216.34", family: 4 });
  });
  it("rechaza si CUALQUIER respuesta de DNS no es pública (rebinding)", () => {
    expect(() => chooseAddress([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], false)).toThrow();
    expect(() => chooseAddress([{ address: "169.254.169.254", family: 4 }], true)).toThrow();
    expect(() => chooseAddress([], false)).toThrow();
  });
  it("con ALLOW_PRIVATE_BASE_URLS acepta la red privada (Ollama)", () => {
    expect(chooseAddress([{ address: "192.168.1.20", family: 4 }], true).address).toBe("192.168.1.20");
  });
});

describe("AssistantService", () => {
  const config = loadConfig();
  const AI = { key: "sk-secreta-1234567890abcd", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
  const make = (opts: { localMode?: boolean; post?: (r: unknown) => Promise<unknown>; job?: unknown } = {}) => {
    const posted: unknown[] = [];
    const service = new AssistantService(
      { ...config, auth: { ...config.auth, localMode: opts.localMode ?? true } },
      { get: async () => opts.job ?? { status: "completed", mediaKind: "video" } } as never,
      async (request: unknown) => {
        posted.push(request);
        return opts.post ? opts.post(request) : { choices: [{ message: { content: "Usa «Traducirlos»." } }] };
      },
    );
    return { service, posted };
  };
  const chat = [{ role: "user", content: "¿Qué hago?" }];

  it("responde con el texto de la IA y manda la clave solo en la cabecera", async () => {
    const { service, posted } = make();
    const out = await service.chat("t1", { messages: chat, jobId: undefined, ai: AI });
    expect(out).toEqual({ reply: "Usa «Traducirlos».", actions: [] });
    expect((posted[0] as { url: string }).url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(JSON.stringify((posted[0] as { body: unknown }).body)).not.toContain("sk-secreta");
  });

  it("con LOCAL_MODE=false responde 404", async () => {
    const { service } = make({ localMode: false });
    await expect(service.chat("t1", { messages: chat, ai: AI })).rejects.toThrow(/no encontrad/i);
  });

  it("sin la configuración de IA responde con un código claro, sin llamar a nadie", async () => {
    const { service, posted } = make();
    await expect(service.chat("t1", { messages: chat })).rejects.toMatchObject({ response: { code: "invalid_ai_config" } });
    expect(posted).toHaveLength(0);
  });

  it("si la IA tarda demasiado, devuelve 504 con un código propio para sugerir un modelo más rápido", async () => {
    const { service } = make({
      post: async () => {
        const error = new Error("tiempo agotado");
        error.name = "AiTimeoutError";
        throw error;
      },
    });
    const error = await service.chat("t1", { messages: chat, ai: AI }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 504, response: { code: "ai_timeout" } });
  });

  it("pide respuestas con holgura: los modelos que razonan gastan parte del tope y se cortaban", () => {
    expect(buildChatRequest({ key: "k", messages: [{ role: "user", content: "x" }], job: null }).body.max_tokens).toBeGreaterThanOrEqual(1500);
  });

  it("si la IA falla, devuelve 502 sin repetir la clave ni el cuerpo del proveedor", async () => {
    const { service } = make({ post: async () => { throw new Error("HTTP 401 sk-secreta-1234567890abcd invalid"); } });
    const error = await service.chat("t1", { messages: chat, ai: AI }).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain("sk-secreta");
    expect(error).toMatchObject({ status: 502 });
  });
});

describe("createPinnedTransport (servidor real en 127.0.0.1)", () => {
  const request = (url: string) => ({ url, headers: { "Content-Type": "application/json" }, body: { model: "m", temperature: 0, max_tokens: 1, messages: [] } });

  async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      return await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`);
    } finally {
      server.close();
    }
  }

  it("sin la bandera, ni http ni la red local se alcanzan", async () => {
    const { createPinnedTransport } = await import("../src/assistant/pinned-https.js");
    await withServer(async (url) => {
      await expect(createPinnedTransport(false)(request(url))).rejects.toThrow();
      await expect(createPinnedTransport(false)(request(url.replace("http:", "https:")))).rejects.toThrow();
    });
  });

  it("con ALLOW_PRIVATE_BASE_URLS llega a un servidor local (Ollama) y devuelve el JSON", async () => {
    const { createPinnedTransport } = await import("../src/assistant/pinned-https.js");
    await withServer(async (url) => {
      expect(parseChatReply(await createPinnedTransport(true)(request(url)))).toBe("ok");
    });
  });
});
