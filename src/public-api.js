import legacyWorker from "./index.js";

const INTERNAL_API_KEY = "__opk_internal_public_api__";
const PROJECT_STATUSES = new Set(["active", "paused", "done", "archived"]);
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return legacyWorker.fetch(request, env);
    }

    try {
      if (url.pathname === "/api/v1/project-ids" && request.method === "POST") {
        const projectId = crypto.randomUUID();
        return json({ ok: true, data: { project_id: projectId, generated_at: now() } }, 201);
      }

      if (url.pathname === "/api/v1/projects/similar" && request.method === "GET") {
        return findSimilarProjects(url, env);
      }

      if (url.pathname === "/api/v1/projects" && request.method === "POST") {
        return createProject(request, env);
      }

      if (url.pathname.startsWith("/api/v1/")) {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${INTERNAL_API_KEY}`);
        const internalRequest = new Request(request, { headers });
        const internalEnv = { ...env, API_KEY: INTERNAL_API_KEY };
        return legacyWorker.fetch(internalRequest, internalEnv);
      }

      return legacyWorker.fetch(request, env);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", path: url.pathname, message: error?.message, stack: error?.stack }));
      if (error instanceof ApiError) return fail(error.status, error.code, error.message, error.details);
      return fail(500, "INTERNAL_ERROR", "Unexpected server error.");
    }
  },
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function createProject(request, env) {
  const body = await readJson(request);
  const requestedId = body.project_id ?? body.id ?? crypto.randomUUID();
  const id = validateProjectId(requestedId);
  const item = {
    id,
    name: requiredString(body.name, "name", 200),
    description: limitedString(body.description, 5000),
    status: body.status || "active",
    priority: body.priority || "medium",
    start_date: nullableDate(body.start_date, "start_date"),
    due_date: nullableDate(body.due_date, "due_date"),
    next_action: limitedString(body.next_action, 2000),
    notes: limitedString(body.notes, 10000),
    created_at: now(),
    updated_at: now(),
  };
  assertEnum(item.status, PROJECT_STATUSES, "status");
  assertEnum(item.priority, PRIORITIES, "priority");
  assertDateOrder(item.start_date, item.due_date);

  const exists = await env.DB.prepare(`SELECT id FROM projects WHERE id=?`).bind(item.id).first();
  if (exists) throw new ApiError(409, "PROJECT_ID_EXISTS", "project_id already exists.", { project_id: item.id });

  await env.DB.prepare(`INSERT INTO projects (id,name,description,status,priority,start_date,due_date,next_action,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(item.id, item.name, item.description, item.status, item.priority, item.start_date, item.due_date, item.next_action, item.notes, item.created_at, item.updated_at).run();

  return json({ ok: true, project_id: item.id, data: item }, 201);
}

async function findSimilarProjects(url, env) {
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) throw new ApiError(400, "VALIDATION_ERROR", "q is required.");
  const thresholdRaw = Number(url.searchParams.get("threshold") ?? "0.45");
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(1, thresholdRaw)) : 0.45;

  const result = await env.DB.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM milestones m WHERE m.project_id=p.id) milestone_count,
    (SELECT COUNT(*) FROM issues i WHERE i.project_id=p.id AND i.status NOT IN ('resolved','closed')) open_issue_count
    FROM projects p ORDER BY p.updated_at DESC`).all();

  const candidates = result.results
    .map((project) => ({
      ...project,
      similarity: Number(nameSimilarity(query, project.name).toFixed(4)),
    }))
    .filter((project) => project.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 10);

  return json({
    ok: true,
    data: {
      query,
      threshold,
      has_candidates: candidates.length > 0,
      candidates,
    },
  });
}

function nameSimilarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const substring = x.includes(y) || y.includes(x) ? 0.9 : 0;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const dice = diceCoefficient(x, y);
  return Math.max(substring, lev, dice);
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_-]+/gu, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        next[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = next;
  }
  return prev[b.length];
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const count = grams.get(g) || 0;
    if (count > 0) {
      overlap += 1;
      grams.set(g, count - 1);
    }
  }
  return (2 * overlap) / ((a.length - 1) + (b.length - 1));
}

function validateProjectId(value) {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(400, "VALIDATION_ERROR", "project_id must be a UUID.");
  }
  return id;
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) throw new ApiError(415, "JSON_REQUIRED", "Content-Type must be application/json.");
  try { return await request.json(); }
  catch { throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON."); }
}

function requiredString(value, field, max) {
  const v = value == null ? "" : String(value).trim();
  if (!v) throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
  if (v.length > max) throw new ApiError(400, "VALIDATION_ERROR", `${field} exceeds ${max} characters.`);
  return v;
}

function limitedString(value, max) {
  const v = value == null ? "" : String(value).trim();
  if (v.length > max) throw new ApiError(400, "VALIDATION_ERROR", `Text exceeds ${max} characters.`);
  return v;
}

function nullableDate(value, field) {
  if (value == null || value === "") return null;
  const v = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be YYYY-MM-DD.`);
  }
  return v;
}

function assertDateOrder(start, due) {
  if (start && due && start > due) throw new ApiError(400, "VALIDATION_ERROR", "due_date cannot be earlier than start_date.");
}

function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new ApiError(400, "VALIDATION_ERROR", `Invalid ${field}: ${value}`);
}

function now() { return new Date().toISOString(); }

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type,Authorization",
    "access-control-max-age": "86400",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function fail(status, code, message, details) {
  return json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status);
}
