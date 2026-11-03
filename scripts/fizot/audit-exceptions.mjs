/** Shared allow-list parsing and advisory filtering for the production audit gate. */

const FAIL_LEVELS = new Set(["high", "critical"]);

export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp);
}

export function parseExceptions(raw, todayIso = new Date().toISOString().slice(0, 10)) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.exceptions)) {
    throw new Error("audit-exceptions.json must be { \"exceptions\": [ ... ] }");
  }
  const active = new Map();
  const errors = [];
  for (const entry of raw.exceptions) {
    if (!entry || typeof entry !== "object") {
      errors.push("exception entry must be an object");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const expiry = typeof entry.expiry === "string" ? entry.expiry.trim() : "";
    if (!id) errors.push("exception missing id (GHSA or CVE)");
    if (!reason) errors.push(`${id || "(no id)"}: reason is required`);
    if (!isIsoDate(expiry)) errors.push(`${id || "(no id)"}: expiry must be YYYY-MM-DD`);
    else if (expiry < todayIso) errors.push(`${id}: exception expired on ${expiry}`);
    else if (id && reason) {
      const row = { id, reason, expiry };
      if (typeof entry.package === "string") row.package = entry.package;
      active.set(id, row);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return active;
}

export function highCriticalFindings(report) {
  const findings = [];
  const seen = new Set();
  const push = (id, severity, pkg, title) => {
    if (!id || !FAIL_LEVELS.has(severity)) return;
    const key = `${id}|${pkg}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ id, severity, package: pkg || "(unknown)", title: title || id });
  };

  if (!report || typeof report !== "object") return findings;

  if (report.advisories && typeof report.advisories === "object" && !Array.isArray(report.advisories)) {
    for (const adv of Object.values(report.advisories)) {
      if (!adv || typeof adv !== "object") continue;
      const severity = String(adv.severity || "").toLowerCase();
      const id = String(adv.github_advisory_id || "");
      push(id, severity, String(adv.module_name || adv.name || ""), String(adv.title || ""));
    }
  }

  if (Array.isArray(report.advisories)) {
    for (const adv of report.advisories) {
      if (!adv || typeof adv !== "object") continue;
      const severity = String(adv.severity || "").toLowerCase();
      const id = String(adv.github_advisory_id || adv.id || "");
      push(id, severity, String(adv.module_name || adv.name || ""), String(adv.title || ""));
    }
  }

  if (report.vulnerabilities && typeof report.vulnerabilities === "object") {
    for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
      if (!vuln || typeof vuln !== "object") continue;
      const severity = String(vuln.severity || "").toLowerCase();
      const vias = Array.isArray(vuln.via) ? vuln.via : [];
      for (const via of vias) {
        if (!via || typeof via !== "object") continue;
        const ghsa = String(via.url || "").match(/GHSA-[\w-]+/)?.[0]
          || (typeof via.source === "string" && String(via.source).startsWith("GHSA-") ? via.source : "")
          || String(via.title || "").match(/GHSA-[\w-]+/)?.[0]
          || "";
        push(ghsa, severity, String(via.name || name), String(via.title || name));
      }
    }
  }

  return findings;
}

export function unmatchedFindings(findings, exceptions) {
  return findings.filter((finding) => !exceptions.has(finding.id));
}
