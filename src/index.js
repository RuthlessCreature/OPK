const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SESSION_COOKIE = "opk_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const PROJECT_STATUSES = new Set(["active", "paused", "done", "archived"]);
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const MILESTONE_STATUSES = new Set(["planned", "in_progress", "blocked", "done", "skipped"]);
const ISSUE_STATUSES = new Set(["open", "in_progress", "waiting", "resolved", "closed"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "opk", version: "0.1.0", time: now() });
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        return handleLogin(request, env);
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return json({ ok: true }, 200, {
          "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        });
      }
      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        const authenticated = await isAuthenticated(request, env);
        return json({ ok: true, authenticated });
      }

      if (!(await isAuthenticated(request, env))) {
        return fail(401, "UNAUTHORIZED", "Password session or Bearer API key required.");
      }

      const route = matchApiRoute(url.pathname);
      if (!route) return fail(404, "NOT_FOUND", "API route not found.");

      switch (route.name) {
        case "dashboard":
          return request.method === "GET" ? getDashboard(env) : methodNotAllowed();
        case "projects":
          if (request.method === "GET") return listProjects(request, env);
          if (request.method === "POST") return createProject(request, env);
          return methodNotAllowed();
        case "project":
          if (request.method === "GET") return getProject(route.id, env);
          if (request.method === "PATCH") return updateProject(route.id, request, env);
          if (request.method === "DELETE") return deleteProject(route.id, env);
          return methodNotAllowed();
        case "projectMilestones":
          if (request.method === "GET") return listMilestones(request, env, route.projectId);
          if (request.method === "POST") return createMilestone(route.projectId, request, env);
          return methodNotAllowed();
        case "milestones":
          return request.method === "GET" ? listMilestones(request, env) : methodNotAllowed();
        case "milestone":
          if (request.method === "PATCH") return updateMilestone(route.id, request, env);
          if (request.method === "DELETE") return deleteMilestone(route.id, env);
          return methodNotAllowed();
        case "projectIssues":
          if (request.method === "GET") return listIssues(request, env, route.projectId);
          if (request.method === "POST") return createIssue(route.projectId, request, env);
          return methodNotAllowed();
        case "issues":
          return request.method === "GET" ? listIssues(request, env) : methodNotAllowed();
        case "issue":
          if (request.method === "PATCH") return updateIssue(route.id, request, env);
          if (request.method === "DELETE") return deleteIssue(route.id, env);
          return methodNotAllowed();
        case "export":
          return request.method === "GET" ? exportAll(env) : methodNotAllowed();
        default:
          return fail(404, "NOT_FOUND", "API route not found.");
      }
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

function matchApiRoute(path) {
  if (path === "/api/v1/dashboard") return { name: "dashboard" };
  if (path === "/api/v1/projects") return { name: "projects" };
  if (path === "/api/v1/milestones") return { name: "milestones" };
  if (path === "/api/v1/issues") return { name: "issues" };
  if (path === "/api/v1/export") return { name: "export" };

  let m = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (m) return { name: "project", id: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/v1\/projects\/([^/]+)\/milestones$/);
  if (m) return { name: "projectMilestones", projectId: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/v1\/projects\/([^/]+)\/issues$/);
  if (m) return { name: "projectIssues", projectId: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/v1\/milestones\/([^/]+)$/);
  if (m) return { name: "milestone", id: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/v1\/issues\/([^/]+)$/);
  if (m) return { name: "issue", id: decodeURIComponent(m[1]) };
  return null;
}

async function handleLogin(request, env) {
  requireSecrets(env, ["DASHBOARD_PASSWORD", "SESSION_SECRET"]);
  const body = await readJson(request);
  const password = string(body.password).trim();
  if (!password || !(await secureEqual(password, env.DASHBOARD_PASSWORD))) {
    return fail(401, "BAD_PASSWORD", "Password is incorrect.");
  }

  const token = await makeSession(env.SESSION_SECRET);
  return json({ ok: true }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
  });
}

async function isAuthenticated(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && env.API_KEY) {
    const token = auth.slice(7).trim();
    if (token && (await secureEqual(token, env.API_KEY))) return true;
  }

  if (!env.SESSION_SECRET) return false;
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  return token ? verifySession(token, env.SESSION_SECRET) : false;
}

async function makeSession(secret) {
  const payload = base64urlEncode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

async function verifySession(token, secret) {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra) return false;
  const expected = await hmac(secret, payload);
  if (!(await secureEqual(sig, expected))) return false;
  try {
    const data = JSON.parse(base64urlDecode(payload));
    return Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function hmac(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return bytesToBase64url(new Uint8Array(sig));
}

async function secureEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

async function getDashboard(env) {
  const today = new Date().toISOString().slice(0, 10);
  const [projectCounts, milestoneCounts, issueCounts, overdueMilestones, urgentIssues, activeProjects] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) count FROM projects GROUP BY status`).all(),
    env.DB.prepare(`SELECT status, COUNT(*) count FROM milestones GROUP BY status`).all(),
    env.DB.prepare(`SELECT status, COUNT(*) count FROM issues GROUP BY status`).all(),
    env.DB.prepare(`SELECT m.*, p.name project_name FROM milestones m JOIN projects p ON p.id=m.project_id WHERE m.due_date IS NOT NULL AND m.due_date < ? AND m.status NOT IN ('done','skipped') ORDER BY m.due_date ASC LIMIT 12`).bind(today).all(),
    env.DB.prepare(`SELECT i.*, p.name project_name FROM issues i JOIN projects p ON p.id=i.project_id WHERE i.status NOT IN ('resolved','closed') ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.updated_at DESC LIMIT 12`).all(),
    env.DB.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM milestones m WHERE m.project_id=p.id AND m.status NOT IN ('done','skipped')) open_milestones,
      (SELECT COUNT(*) FROM issues i WHERE i.project_id=p.id AND i.status NOT IN ('resolved','closed')) open_issues
      FROM projects p WHERE p.status='active'
      ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, COALESCE(p.due_date,'9999-12-31'), p.updated_at DESC`).all(),
  ]);

  return json({
    ok: true,
    data: {
      today,
      project_counts: rowsToMap(projectCounts.results),
      milestone_counts: rowsToMap(milestoneCounts.results),
      issue_counts: rowsToMap(issueCounts.results),
      active_projects: activeProjects.results,
      overdue_milestones: overdueMilestones.results,
      priority_issues: urgentIssues.results,
    },
  });
}

async function listProjects(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q")?.trim();
  const where = [];
  const values = [];
  if (status) {
    assertEnum(status, PROJECT_STATUSES, "status");
    where.push("p.status = ?");
    values.push(status);
  }
  if (q) {
    where.push("(p.name LIKE ? OR p.description LIKE ? OR p.next_action LIKE ? OR p.notes LIKE ?)");
    const like = `%${q}%`;
    values.push(like, like, like, like);
  }
  const sql = `SELECT p.*,
    (SELECT COUNT(*) FROM milestones m WHERE m.project_id=p.id) milestone_count,
    (SELECT COUNT(*) FROM milestones m WHERE m.project_id=p.id AND m.status='done') milestone_done_count,
    (SELECT COUNT(*) FROM issues i WHERE i.project_id=p.id AND i.status NOT IN ('resolved','closed')) open_issue_count
    FROM projects p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
             CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             COALESCE(p.due_date,'9999-12-31'), p.updated_at DESC`;
  const result = await env.DB.prepare(sql).bind(...values).all();
  return json({ ok: true, data: result.results });
}

async function createProject(request, env) {
  const body = await readJson(request);
  const item = {
    id: crypto.randomUUID(),
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

  await env.DB.prepare(`INSERT INTO projects (id,name,description,status,priority,start_date,due_date,next_action,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(item.id, item.name, item.description, item.status, item.priority, item.start_date, item.due_date, item.next_action, item.notes, item.created_at, item.updated_at).run();
  return json({ ok: true, data: item }, 201);
}

async function getProject(id, env) {
  const project = await env.DB.prepare(`SELECT * FROM projects WHERE id=?`).bind(id).first();
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found.");
  const [milestones, issues] = await Promise.all([
    env.DB.prepare(`SELECT * FROM milestones WHERE project_id=? ORDER BY sort_order ASC, COALESCE(due_date,'9999-12-31'), created_at`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM issues WHERE project_id=? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC`).bind(id).all(),
  ]);
  return json({ ok: true, data: { ...project, milestones: milestones.results, issues: issues.results } });
}

async function updateProject(id, request, env) {
  await ensureProject(id, env);
  const body = await readJson(request);
  const allowed = ["name", "description", "status", "priority", "start_date", "due_date", "next_action", "notes"];
  const patch = pick(body, allowed);
  if ("name" in patch) patch.name = requiredString(patch.name, "name", 200);
  if ("description" in patch) patch.description = limitedString(patch.description, 5000);
  if ("status" in patch) assertEnum(patch.status, PROJECT_STATUSES, "status");
  if ("priority" in patch) assertEnum(patch.priority, PRIORITIES, "priority");
  if ("start_date" in patch) patch.start_date = nullableDate(patch.start_date, "start_date");
  if ("due_date" in patch) patch.due_date = nullableDate(patch.due_date, "due_date");
  if ("next_action" in patch) patch.next_action = limitedString(patch.next_action, 2000);
  if ("notes" in patch) patch.notes = limitedString(patch.notes, 10000);
  if (!Object.keys(patch).length) throw new ApiError(400, "EMPTY_PATCH", "No editable fields supplied.");

  if ("start_date" in patch || "due_date" in patch) {
    const existing = await env.DB.prepare(`SELECT start_date,due_date FROM projects WHERE id=?`).bind(id).first();
    assertDateOrder("start_date" in patch ? patch.start_date : existing.start_date, "due_date" in patch ? patch.due_date : existing.due_date);
  }
  await updateRow(env.DB, "projects", id, patch);
  return getProject(id, env);
}

async function deleteProject(id, env) {
  const result = await env.DB.prepare(`DELETE FROM projects WHERE id=?`).bind(id).run();
  if (!result.meta.changes) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found.");
  return json({ ok: true, deleted: id });
}

async function listMilestones(request, env, forcedProjectId = null) {
  const url = new URL(request.url);
  const projectId = forcedProjectId || url.searchParams.get("project_id");
  const status = url.searchParams.get("status");
  const where = [];
  const values = [];
  if (projectId) { where.push("m.project_id=?"); values.push(projectId); }
  if (status) { assertEnum(status, MILESTONE_STATUSES, "status"); where.push("m.status=?"); values.push(status); }
  const result = await env.DB.prepare(`SELECT m.*, p.name project_name FROM milestones m JOIN projects p ON p.id=m.project_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(m.due_date,'9999-12-31'), m.sort_order, m.created_at`).bind(...values).all();
  return json({ ok: true, data: result.results });
}

async function createMilestone(projectId, request, env) {
  await ensureProject(projectId, env);
  const body = await readJson(request);
  const item = {
    id: crypto.randomUUID(), project_id: projectId,
    title: requiredString(body.title, "title", 300),
    status: body.status || "planned",
    due_date: nullableDate(body.due_date, "due_date"),
    sort_order: integer(body.sort_order, 0, -100000, 100000),
    notes: limitedString(body.notes, 10000),
    created_at: now(), updated_at: now(),
  };
  assertEnum(item.status, MILESTONE_STATUSES, "status");
  await env.DB.prepare(`INSERT INTO milestones (id,project_id,title,status,due_date,sort_order,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(item.id,item.project_id,item.title,item.status,item.due_date,item.sort_order,item.notes,item.created_at,item.updated_at).run();
  return json({ ok: true, data: item }, 201);
}

async function updateMilestone(id, request, env) {
  const exists = await env.DB.prepare(`SELECT id FROM milestones WHERE id=?`).bind(id).first();
  if (!exists) throw new ApiError(404, "MILESTONE_NOT_FOUND", "Milestone not found.");
  const body = await readJson(request);
  const patch = pick(body, ["title","status","due_date","sort_order","notes"]);
  if ("title" in patch) patch.title = requiredString(patch.title, "title", 300);
  if ("status" in patch) assertEnum(patch.status, MILESTONE_STATUSES, "status");
  if ("due_date" in patch) patch.due_date = nullableDate(patch.due_date, "due_date");
  if ("sort_order" in patch) patch.sort_order = integer(patch.sort_order, 0, -100000, 100000);
  if ("notes" in patch) patch.notes = limitedString(patch.notes, 10000);
  if (!Object.keys(patch).length) throw new ApiError(400, "EMPTY_PATCH", "No editable fields supplied.");
  await updateRow(env.DB, "milestones", id, patch);
  const item = await env.DB.prepare(`SELECT * FROM milestones WHERE id=?`).bind(id).first();
  return json({ ok: true, data: item });
}

async function deleteMilestone(id, env) {
  const result = await env.DB.prepare(`DELETE FROM milestones WHERE id=?`).bind(id).run();
  if (!result.meta.changes) throw new ApiError(404, "MILESTONE_NOT_FOUND", "Milestone not found.");
  return json({ ok: true, deleted: id });
}

async function listIssues(request, env, forcedProjectId = null) {
  const url = new URL(request.url);
  const projectId = forcedProjectId || url.searchParams.get("project_id");
  const status = url.searchParams.get("status");
  const severity = url.searchParams.get("severity");
  const where = [];
  const values = [];
  if (projectId) { where.push("i.project_id=?"); values.push(projectId); }
  if (status) { assertEnum(status, ISSUE_STATUSES, "status"); where.push("i.status=?"); values.push(status); }
  if (severity) { assertEnum(severity, SEVERITIES, "severity"); where.push("i.severity=?"); values.push(severity); }
  const result = await env.DB.prepare(`SELECT i.*, p.name project_name, m.title milestone_title FROM issues i JOIN projects p ON p.id=i.project_id LEFT JOIN milestones m ON m.id=i.milestone_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.updated_at DESC`).bind(...values).all();
  return json({ ok: true, data: result.results });
}

async function createIssue(projectId, request, env) {
  await ensureProject(projectId, env);
  const body = await readJson(request);
  const milestoneId = body.milestone_id ? string(body.milestone_id) : null;
  if (milestoneId) {
    const milestone = await env.DB.prepare(`SELECT id FROM milestones WHERE id=? AND project_id=?`).bind(milestoneId, projectId).first();
    if (!milestone) throw new ApiError(400, "INVALID_MILESTONE", "milestone_id does not belong to this project.");
  }
  const item = {
    id: crypto.randomUUID(), project_id: projectId, milestone_id: milestoneId,
    title: requiredString(body.title, "title", 300),
    description: limitedString(body.description, 5000),
    status: body.status || "open", severity: body.severity || "medium",
    next_action: limitedString(body.next_action, 2000), notes: limitedString(body.notes, 10000),
    created_at: now(), updated_at: now(),
  };
  assertEnum(item.status, ISSUE_STATUSES, "status");
  assertEnum(item.severity, SEVERITIES, "severity");
  await env.DB.prepare(`INSERT INTO issues (id,project_id,milestone_id,title,description,status,severity,next_action,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(item.id,item.project_id,item.milestone_id,item.title,item.description,item.status,item.severity,item.next_action,item.notes,item.created_at,item.updated_at).run();
  return json({ ok: true, data: item }, 201);
}

async function updateIssue(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM issues WHERE id=?`).bind(id).first();
  if (!existing) throw new ApiError(404, "ISSUE_NOT_FOUND", "Issue not found.");
  const body = await readJson(request);
  const patch = pick(body, ["milestone_id","title","description","status","severity","next_action","notes"]);
  if ("milestone_id" in patch) {
    patch.milestone_id = patch.milestone_id ? string(patch.milestone_id) : null;
    if (patch.milestone_id) {
      const milestone = await env.DB.prepare(`SELECT id FROM milestones WHERE id=? AND project_id=?`).bind(patch.milestone_id, existing.project_id).first();
      if (!milestone) throw new ApiError(400, "INVALID_MILESTONE", "milestone_id does not belong to this project.");
    }
  }
  if ("title" in patch) patch.title = requiredString(patch.title, "title", 300);
  if ("description" in patch) patch.description = limitedString(patch.description, 5000);
  if ("status" in patch) assertEnum(patch.status, ISSUE_STATUSES, "status");
  if ("severity" in patch) assertEnum(patch.severity, SEVERITIES, "severity");
  if ("next_action" in patch) patch.next_action = limitedString(patch.next_action, 2000);
  if ("notes" in patch) patch.notes = limitedString(patch.notes, 10000);
  if (!Object.keys(patch).length) throw new ApiError(400, "EMPTY_PATCH", "No editable fields supplied.");
  await updateRow(env.DB, "issues", id, patch);
  const item = await env.DB.prepare(`SELECT * FROM issues WHERE id=?`).bind(id).first();
  return json({ ok: true, data: item });
}

async function deleteIssue(id, env) {
  const result = await env.DB.prepare(`DELETE FROM issues WHERE id=?`).bind(id).run();
  if (!result.meta.changes) throw new ApiError(404, "ISSUE_NOT_FOUND", "Issue not found.");
  return json({ ok: true, deleted: id });
}

async function exportAll(env) {
  const [projects, milestones, issues] = await Promise.all([
    env.DB.prepare(`SELECT * FROM projects ORDER BY created_at`).all(),
    env.DB.prepare(`SELECT * FROM milestones ORDER BY created_at`).all(),
    env.DB.prepare(`SELECT * FROM issues ORDER BY created_at`).all(),
  ]);
  return json({ ok: true, exported_at: now(), data: { projects: projects.results, milestones: milestones.results, issues: issues.results } });
}

async function updateRow(db, table, id, patch) {
  const entries = Object.entries(patch);
  const updatedAt = now();
  const sql = `UPDATE ${table} SET ${entries.map(([k]) => `${k}=?`).join(", ")}, updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...entries.map(([,v]) => v), updatedAt, id).run();
}

async function ensureProject(id, env) {
  const item = await env.DB.prepare(`SELECT id FROM projects WHERE id=?`).bind(id).first();
  if (!item) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found.");
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) throw new ApiError(415, "JSON_REQUIRED", "Content-Type must be application/json.");
  try { return await request.json(); }
  catch { throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON."); }
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  return out;
}
function requiredString(value, field, max) {
  const v = string(value).trim();
  if (!v) throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
  if (v.length > max) throw new ApiError(400, "VALIDATION_ERROR", `${field} exceeds ${max} characters.`);
  return v;
}
function limitedString(value, max) {
  const v = value == null ? "" : string(value).trim();
  if (v.length > max) throw new ApiError(400, "VALIDATION_ERROR", `Text exceeds ${max} characters.`);
  return v;
}
function string(value) { return value == null ? "" : String(value); }
function integer(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, "VALIDATION_ERROR", "Invalid integer value.");
  return n;
}
function nullableDate(value, field) {
  if (value == null || value === "") return null;
  const v = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new ApiError(400, "VALIDATION_ERROR", `${field} must be YYYY-MM-DD.`);
  return v;
}
function assertDateOrder(start, due) {
  if (start && due && start > due) throw new ApiError(400, "VALIDATION_ERROR", "due_date cannot be earlier than start_date.");
}
function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new ApiError(400, "VALIDATION_ERROR", `Invalid ${field}: ${value}`);
}
function now() { return new Date().toISOString(); }
function rowsToMap(rows) { return Object.fromEntries(rows.map(r => [r.status, Number(r.count)])); }
function parseCookies(raw) {
  return Object.fromEntries(raw.split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf("="); return i < 0 ? [v, ""] : [v.slice(0,i), v.slice(i+1)];
  }));
}
function base64urlEncode(text) { return bytesToBase64url(new TextEncoder().encode(text)); }
function base64urlDecode(text) {
  const base64 = text.replace(/-/g,"+").replace(/_/g,"/") + "===".slice((text.length + 3) % 4);
  const bin = atob(base64); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function bytesToBase64url(bytes) {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function requireSecrets(env, names) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) throw new ApiError(500, "CONFIG_ERROR", `Missing secrets: ${missing.join(", ")}`);
}
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type",
    "access-control-max-age": "86400",
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...corsHeaders(), "cache-control": "no-store", ...extra } });
}
function fail(status, code, message, details) { return json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status); }
function methodNotAllowed() { return fail(405, "METHOD_NOT_ALLOWED", "Method not allowed."); }
