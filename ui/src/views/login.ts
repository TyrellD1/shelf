import { h, mount } from "../dom.js";
import type { AppContext } from "../context.js";

export function createLoginView(ctx: AppContext, onSuccess: () => void): HTMLElement {
  const email = h("input", {
    attrs: { type: "email", name: "email", autocomplete: "username", required: true, placeholder: "Email" },
  });
  const password = h("input", {
    attrs: {
      type: "password",
      name: "password",
      autocomplete: "current-password",
      required: true,
      placeholder: "Password",
    },
  });
  const error = h("p", { class: "error", attrs: { hidden: true } });
  const submit = h("button", { attrs: { type: "submit" }, text: "Sign in" });

  const form = h(
    "form",
    {
      on: {
        submit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          submit.textContent = "Signing in…";
          try {
            await ctx.adapter.signIn?.(email.value.trim(), password.value);
            onSuccess();
          } catch (cause) {
            error.textContent = cause instanceof Error ? cause.message : String(cause);
            error.hidden = false;
            submit.disabled = false;
            submit.textContent = "Sign in";
          }
        },
      },
    },
    h("h1", { text: "Shelf" }),
    h("p", { text: "Sign in to read and write your shelf from the network." }),
    email,
    password,
    error,
    submit,
  );

  const view = h("div", { class: "login" }, form);
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  if (next) {
    const note = h("p", { text: `You were on your way to ${next}.` });
    form.insertBefore(note, form.firstChild?.nextSibling ?? null);
  }
  return view;
}

export function renderLoginInto(root: Element, ctx: AppContext, onSuccess: () => void): void {
  mount(root, createLoginView(ctx, onSuccess));
}
