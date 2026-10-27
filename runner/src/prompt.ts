export interface RunContext {
  project: string
  mr_iid?: number
  issue_iid?: number
  pipeline_id?: number
  // The branch a pipeline ran on (set by the orchestrator): cloned, and the target of the fix.
  branch?: string
  // Free-text instruction typed by the user in the extension.
  instruction?: string
}

// Fills {{project.path}}, {{mr.iid}}, {{issue.iid}}, {{pipeline.id}}, {{pipeline.branch}}; an unknown or missing placeholder fails the run instead of reaching the model empty.
export function renderPrompt(template: string, ctx: RunContext): string {
  const values: Record<string, unknown> = {
    'project.path': ctx.project, 'mr.iid': ctx.mr_iid, 'issue.iid': ctx.issue_iid, 'pipeline.id': ctx.pipeline_id, 'pipeline.branch': ctx.branch,
  }
  const prompt = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (values[key] === undefined) throw new Error(`prompt placeholder {{${key}}} has no value in this context`)
    return String(values[key])
  })
  return ctx.instruction ? `${prompt}\n\nConsigne de l'utilisateur :\n${ctx.instruction}` : prompt
}
