// Stand-ins for Orca's worker host APIs, shared by the Web API tests.

export function fakeSecrets(initial = {}, { failSet = false } = {}) {
  const values = { ...initial }
  return {
    values,
    get: async (key) => values[key] ?? null,
    set: async (key, value) => {
      if (failSet) throw Object.assign(new Error('no keyring'), { code: 'action_failed' })
      values[key] = value
    },
    delete: async (key) => {
      delete values[key]
    }
  }
}

export function fakeSettings(values = {}) {
  return {
    values,
    get: async (key) => values[key],
    set: async (key, value) => {
      values[key] = value
    }
  }
}

// A fetch Response stand-in with a JSON body.
export function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  }
}

// api.spotify.com stand-in that answers by "METHOD /path" (query left out). A route is a reply,
// a list of replies used in turn (the last one repeats), or a function of the request.
export function fakeSpotifyApi(routes = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const method = init.method ?? 'GET'
    const path = parsed.pathname.replace(/^\/v1/, '')
    const request = {
      method,
      path,
      query: Object.fromEntries(parsed.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined
    }
    requests.push(request)
    let route = routes[`${method} ${path}`]
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0]
    if (typeof route === 'function') route = route(request)
    return route ?? reply(204)
  }
  return { fetchImpl, requests, routes }
}
