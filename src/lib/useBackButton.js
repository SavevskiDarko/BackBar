import { useEffect, useRef } from "react";

/* ===========================================================================
   The Android back button.

   In an installed app, back with nothing to go back to leaves the app. Mid
   service, with a table half ordered, that is bad. So every overlay pushes a
   history entry when it opens, and back pops it instead of exiting.

   One listener and one stack, deliberately. The usual way this breaks is each
   overlay adding its own popstate listener: they all fire on one press, close
   each other, and the app jumps two screens back or exits anyway.
   =========================================================================== */

const stack = [];        // open layers, innermost last
let rootHandler = null;  // what to do when back is pressed with nothing open
let started = false;

// history.back() in our own cleanup fires popstate too. Without this the
// listener would pop a layer that nobody asked to close.
let ignore = 0;

function start() {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("popstate", () => {
    if (ignore > 0) { ignore -= 1; return; }

    const top = stack.pop();
    if (top) { top.close(); return; }

    if (rootHandler) {
      rootHandler();
      // Put an entry back so there is something to pop next time.
      window.history.pushState({ bb: "root" }, "");
    }
  });
}

/** Close this layer on back. Mount it only while the layer is open. */
export function useBackLayer(isOpen, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    start();

    const entry = { close: () => closeRef.current?.() };
    stack.push(entry);
    window.history.pushState({ bb: stack.length }, "");

    return () => {
      const i = stack.indexOf(entry);
      if (i === -1) return;      // back already closed it; the entry is gone
      stack.splice(i, 1);
      ignore += 1;               // this back() is ours, not the user's
      window.history.back();
    };
  }, [isOpen]);
}

/**
 * What happens when back is pressed with nothing open. Press once and it warns;
 * press again within a couple of seconds and the app closes.
 *
 * A single press exiting is too easy on a tablet living on a bar wall — a
 * waiter brushing the navigation bar shouldn't drop the floor.
 */
export function useExitGuard(onWarn) {
  const warnRef = useRef(onWarn);
  warnRef.current = onWarn;

  useEffect(() => {
    if (typeof window === "undefined") return;
    start();

    // Something has to be on the stack for back to pop.
    if (!window.history.state?.bb) window.history.pushState({ bb: "root" }, "");

    let armed = false;
    let timer;

    rootHandler = () => {
      if (armed) {
        // Second press: stop intercepting and let the next one leave.
        rootHandler = null;
        window.history.back();
        return;
      }
      armed = true;
      warnRef.current?.();
      timer = setTimeout(() => { armed = false; }, 2500);
    };

    return () => {
      rootHandler = null;
      clearTimeout(timer);
    };
  }, []);
}
