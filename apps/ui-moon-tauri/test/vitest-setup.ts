// Vitest setup — runs once per test file BEFORE any test code. Repairs the
// Bun/jsdom Storage incompatibility:
//   - jsdom provides a working `Storage` constructor and exposes `localStorage`
//     / `sessionStorage` instances inheriting from `Storage.prototype`.
//   - Bun ships its own `localStorage`/`sessionStorage` GLOBALS that are
//     plain `[Object: null prototype] {}` stubs. They shadow jsdom's and
//     break every test that calls `.clear()`, `.setItem()`, or spies on
//     `Storage.prototype.setItem` (which the app's persisted-prefs tests do).
//
// Strategy: install Map-backed implementations on Storage.prototype itself,
// then construct two fresh `Storage`-prototyped instances and bind them to
// `localStorage` / `sessionStorage` on both `window` and `globalThis`. This
// way `localStorage instanceof Storage` is true, `vi.spyOn(Storage.prototype,
// 'setItem')` actually intercepts, and the app code's read/write loop works.
const stores = new WeakMap<object, Map<string, string>>()
function back(self: object): Map<string, string> {
  let m = stores.get(self)
  if (!m) { m = new Map<string, string>(); stores.set(self, m) }
  return m
}

if (typeof Storage !== 'undefined') {
  Storage.prototype.setItem = function (key: string, value: string) {
    back(this).set(String(key), String(value))
  }
  Storage.prototype.getItem = function (key: string): string | null {
    const m = back(this)
    return m.has(String(key)) ? (m.get(String(key)) as string) : null
  }
  Storage.prototype.removeItem = function (key: string) {
    back(this).delete(String(key))
  }
  Storage.prototype.clear = function () {
    back(this).clear()
  }
  Storage.prototype.key = function (i: number): string | null {
    const ks = Array.from(back(this).keys())
    return i >= 0 && i < ks.length ? ks[i] : null
  }
  Object.defineProperty(Storage.prototype, 'length', {
    configurable: true,
    get() { return back(this).size },
  })
}

function installInstance(target: any, prop: 'localStorage' | 'sessionStorage') {
  const instance = typeof Storage !== 'undefined'
    ? Object.create(Storage.prototype)
    : Object.create(null)
  try {
    Object.defineProperty(target, prop, {
      configurable: true,
      enumerable: true,
      get() { return instance },
    })
  } catch {
    try { target[prop] = instance } catch { /* read-only on Bun; ignore */ }
  }
}
installInstance(window, 'localStorage')
installInstance(window, 'sessionStorage')
installInstance(globalThis as any, 'localStorage')
installInstance(globalThis as any, 'sessionStorage')

// jsdom does not implement window.matchMedia. @astryxdesign/core's useTheme
// (pulled in by, among others, Spinner - rendered by Switch/ToggleButton
// while isLoading/isPending) calls it unconditionally via its own
// useMediaQuery hook, so any test that mounts a real Astryx component tree
// needs this stub present before React renders. Static "no match, no
// listeners fire" implementation - none of these tests assert on live
// media-query changes, only that mounting doesn't throw.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = function matchMedia(query: string): MediaQueryList {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
    } as MediaQueryList
  }
}
