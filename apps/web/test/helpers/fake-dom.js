// DOM mínimo para probar la interfaz sin navegador: lo justo que usan ui/account.js y ui/team.js.
export class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.className = "";
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.classList = { add: (name) => (this.className = `${this.className} ${name}`.trim()) };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {} }); }
}

