// Equipos (ADR 0019): selector de espacio de trabajo, miembros e invitaciones. Todo texto entra con textContent.
// Gestionar miembros e invitar es del Dueño: el resto de roles no ve el botón. El API lo exige igualmente (403).

import { ApiError } from "../api/errors.js";
import { createInvite, listInvites, listMembers, listWorkspaces, removeMember, revokeInvite, setMemberRole, switchWorkspace } from "../api/workspaces.js";

const ROLES = /** @type {const} */ (["OWNER", "EDITOR", "VIEWER"]);
const CONFIRM_RESET_MS = 4000;

/**
 * @param {{
 *   doc: Document, win: Window, baseUrl: string, access: import("../api/access.js").Access,
 *   t: (key: string, params?: Record<string, string | number>) => string,
 *   announce?: (text: string) => void, notify?: (text: string) => void, fetchImpl?: typeof fetch,
 * }} deps
 */
export function createTeam({ doc, win, baseUrl, access, t: initialT, announce = () => {}, notify = () => {}, fetchImpl }) {
  /** @type {(id: string) => any} */
  const $ = (id) => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`Falta el elemento #${id}`);
    return element;
  };
  const els = {
    select: $("workspace-select"),
    toggle: $("account-team-toggle"),
    panel: $("team-panel"),
    members: $("team-members"),
    problem: $("team-problem"),
    form: $("team-invite-form"),
    inviteRole: $("team-invite-role"),
    created: $("team-link-box"),
    link: $("team-link"),
    copy: $("team-copy"),
    invites: $("team-invites"),
    noInvites: $("team-invites-empty"),
  };

  let t = initialT;
  const signedIn = access.mode === "session";
  const isOwner = signedIn && access.me?.role === "OWNER";
  const myId = access.me?.user?.id ?? null;
  /** @type {import("../api/workspaces.js").Workspace[]} */
  let workspaces = [];
  /** @type {import("../api/workspaces.js").Member[]} */
  let members = [];
  /** @type {import("../api/workspaces.js").Invite[]} */
  let invites = [];
  let loaded = false;
  /** @type {string | null} */
  let problem = null;
  let copied = false;
  /** @type {string | null} */
  let confirming = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let confirmTimer;

  els.toggle.hidden = !isOwner;
  els.select.hidden = true;
  const base = { baseUrl, fetchImpl };

  const dateText = (/** @type {string} */ iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(doc.documentElement.lang || "es", { year: "numeric", month: "short", day: "numeric" });
  };
  const nameOf = (/** @type {import("../api/workspaces.js").Member} */ member) => member.name ?? member.email ?? t("team.unnamed");

  /** @param {unknown} error */
  function describe(error) {
    if (error instanceof ApiError) {
      // El API distingue los 409 con un código estable: «último Dueño», «tope de invitaciones» y «único espacio de esa persona».
      if (error.code === "last_owner") return t("team.error.lastOwner");
      if (error.code === "invite_limit") return t("team.error.inviteLimit");
      if (error.code === "last_membership") return t("team.error.lastMembership");
    }
    const code = error instanceof ApiError ? error.code : "network";
    return t(`error.${code}`, { seconds: error instanceof ApiError ? (error.retryAfter ?? 10) : 10 });
  }

  function renderWorkspaces() {
    els.select.hidden = workspaces.length < 2;
    els.select.setAttribute("aria-label", t("account.workspace"));
    els.select.replaceChildren(
      ...workspaces.map((workspace) => {
        const option = doc.createElement("option");
        option.value = workspace.id;
        option.textContent = `${workspace.name} · ${t(`role.${workspace.role}`)}`;
        option.selected = workspace.active;
        return option;
      }),
    );
    const active = workspaces.find((workspace) => workspace.active);
    if (active) els.select.value = active.id;
  }

  function renderMembers() {
    els.members.replaceChildren(
      ...members.map((member) => {
        const item = doc.createElement("li");
        item.className = "team__row";
        const label = doc.createElement("span");
        label.className = "team__name";
        label.textContent = member.userId === myId ? `${nameOf(member)} (${t("team.you")})` : nameOf(member);

        const role = doc.createElement("select");
        role.className = "team__role";
        role.setAttribute("aria-label", t("team.roleFor", { name: nameOf(member) }));
        for (const value of ROLES) {
          const option = doc.createElement("option");
          option.value = value;
          option.textContent = t(`role.${value}`);
          option.selected = value === member.role;
          role.append(option);
        }
        role.value = member.role;
        role.addEventListener("change", () => void changeRole(member, role.value));

        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "btn btn--ghost";
        remove.textContent = confirming === member.userId ? t("team.remove.confirm") : t("team.remove");
        remove.setAttribute("aria-label", t("team.removeFor", { name: nameOf(member) }));
        remove.addEventListener("click", () => void askRemove(member));
        item.append(label, role, remove);
        return item;
      }),
    );
  }

  function renderInvites() {
    els.invites.replaceChildren(
      ...invites.map((invite) => {
        const item = doc.createElement("li");
        item.className = "team__row";
        const label = doc.createElement("span");
        label.className = "team__name";
        label.textContent = `${t(`role.${invite.role}`)} · ${t("team.invite.expires", { date: dateText(invite.expiresAt) })}`;
        const revoke = doc.createElement("button");
        revoke.type = "button";
        revoke.className = "btn btn--ghost";
        revoke.textContent = t("team.revoke");
        revoke.addEventListener("click", () => void revokePending(invite));
        item.append(label, revoke);
        return item;
      }),
    );
    els.noInvites.hidden = !loaded || invites.length > 0;
  }

  function render() {
    renderWorkspaces();
    if (!isOwner) return;
    renderMembers();
    renderInvites();
    els.problem.textContent = problem ?? "";
    els.problem.hidden = problem === null;
    els.copy.textContent = copied ? t("team.copied") : t("team.copy");
  }

  async function loadWorkspaces() {
    try {
      workspaces = await listWorkspaces(base);
    } catch {
      workspaces = []; // sin selector: la interfaz sigue funcionando en el espacio activo
    }
    renderWorkspaces();
  }

  async function loadTeam() {
    try {
      [members, invites] = await Promise.all([listMembers(base), listInvites(base)]);
      loaded = true;
      problem = null;
    } catch (error) {
      problem = describe(error);
    }
    render();
  }

  /** @param {import("../api/workspaces.js").Member} member @param {string} role */
  async function changeRole(member, role) {
    try {
      await setMemberRole({ ...base, userId: member.userId, role: /** @type {"OWNER" | "EDITOR" | "VIEWER"} */ (role) });
      announce(t("team.roleChangedAnnounce", { name: nameOf(member), role: t(`role.${role}`) }));
      if (member.userId === myId) return void win.location.reload(); // su propio rol cambió: toda la interfaz depende de él
      await loadTeam();
    } catch (error) {
      const message = describe(error);
      await loadTeam(); // vuelve a mostrar el rol real (y borra avisos viejos)
      problem = message;
      render();
    }
  }

  /** Quitar pide una segunda pulsación (nada de diálogos del navegador): la primera cambia el botón, la segunda confirma. @param {import("../api/workspaces.js").Member} member */
  async function askRemove(member) {
    if (confirming !== member.userId) {
      confirming = member.userId;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        confirming = null;
        render();
      }, CONFIRM_RESET_MS);
      return render();
    }
    confirming = null;
    clearTimeout(confirmTimer);
    try {
      await removeMember({ ...base, userId: member.userId });
      announce(t("team.removedAnnounce", { name: nameOf(member) }));
      if (member.userId === myId) return void win.location.reload();
      await loadTeam();
    } catch (error) {
      problem = describe(error);
      render();
    }
  }

  /** @param {import("../api/workspaces.js").Invite} invite */
  async function revokePending(invite) {
    try {
      await revokeInvite({ ...base, id: invite.id });
      await loadTeam();
    } catch (error) {
      problem = describe(error);
      render();
    }
  }

  els.select.addEventListener("change", () => {
    void switchWorkspace({ ...base, tenantId: els.select.value })
      .then(() => win.location.reload())
      .catch((/** @type {unknown} */ error) => {
        renderWorkspaces(); // el selector vuelve al espacio que sigue activo
        notify(describe(error)); // visible para Editor y Lector también: su panel de equipo no existe
      });
  });

  els.toggle.addEventListener("click", () => {
    const open = els.panel.hidden;
    els.panel.hidden = !open;
    els.toggle.setAttribute("aria-expanded", String(open));
    if (open && !loaded) void loadTeam();
  });

  els.form.addEventListener("submit", (/** @type {Event} */ event) => {
    event.preventDefault();
    void (async () => {
      try {
        const created = await createInvite({ ...base, role: /** @type {"EDITOR" | "VIEWER"} */ (els.inviteRole.value) });
        els.link.textContent = created.link; // se ve UNA vez: el servidor solo guarda su hash
        els.created.hidden = false;
        copied = false;
        announce(t("team.inviteCreatedAnnounce"));
        await loadTeam();
      } catch (error) {
        problem = describe(error);
        render();
      }
    })();
  });

  els.copy.addEventListener("click", () => {
    void (async () => {
      try {
        await win.navigator.clipboard.writeText(els.link.textContent ?? "");
        copied = true;
      } catch {
        win.getSelection()?.selectAllChildren(els.link); // sin permiso del portapapeles: se selecciona para copiarlo a mano
      }
      render();
    })();
  });

  if (signedIn) void loadWorkspaces();
  render();
  return {
    /** @param {typeof initialT} next */
    refresh(next) {
      t = next;
      render();
    },
  };
}
