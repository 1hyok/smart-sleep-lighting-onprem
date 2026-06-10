import { mockRequest, USE_MOCK } from "./mock";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = "GET", body, signal } = {}) {
  // 데모/스크린샷 모드: 백엔드 없이 가짜 데이터로 모든 화면을 채운다.
  if (USE_MOCK) return mockRequest(path, { method, body });

  const url = `${BASE_URL}${path}`;
  const init = { method, signal, headers: {} };

  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const message = data?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, { status: res.status, body: data });
  }

  return data;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const apiClient = {
  get: (path, opts) => request(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => request(path, { ...opts, method: "POST", body }),
  delete: (path, opts) => request(path, { ...opts, method: "DELETE" }),
};

export { ApiError, BASE_URL };
