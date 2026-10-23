// DOM mínimo para probar la interfaz sin navegador: lo justo que usan ui/account.js, ui/team.js, ui/external-keys.js y ui/ai.js.
export class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.textContent = "";
    this.value = "";
    this.className = "";
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.focused = false;
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (name) => (this.className = [...new Set([...classes(), name])].join(" ")),
      remove: (name) => (this.className = classes().filter((other) => other !== name).join(" ")),
      contains: (name) => classes().includes(name),
      toggle: (name, force) => {
        const on = force ?? !classes().includes(name);
        if (on) this.classList.add(name);
        else this.classList.remove(name);
        return on;
      },
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {} }); }
  click() { if (!this.disabled) this.fire("click"); }
  focus() { this.focused = true; }
  remove() {}
}

/** <dialog> con showModal/close, como el nativo. */
export class FakeDialog extends FakeElement {
  constructor(id = "") {
    super(id);
    this.open = false;
    this.showModalCalls = 0;
  }
  showModal() { this.open = true; this.showModalCalls += 1; }
  close() { this.open = false; }
}
