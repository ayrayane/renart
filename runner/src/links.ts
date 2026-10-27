import type { RunContext } from './prompt.ts'

// Where to see what a GitLab tool just wrote, so the extension can link straight to it.
export function linkFor(tool: string, result: unknown, ctx: RunContext, gitlabUrl: string): { label: string; url: string } | null {
  const base = `${gitlabUrl.replace(/\/$/, '')}/${ctx.project}/-`
  const r = (result ?? {}) as { id?: number; web_url?: string; iid?: number; noteable_iid?: number; notes?: { id: number }[] }
  switch (tool.replace('mcp__gitlab__', '')) {
    case 'comment_merge_request':
      return r.id ? { label: 'Commentaire', url: `${base}/merge_requests/${r.noteable_iid ?? ctx.mr_iid}#note_${r.id}` } : null
    case 'comment_diff_line':
      return r.notes?.[0]?.id ? { label: 'Commentaire sur une ligne', url: `${base}/merge_requests/${ctx.mr_iid}#note_${r.notes[0].id}` } : null
    case 'comment_issue':
      return r.id ? { label: 'Commentaire', url: `${base}/issues/${ctx.issue_iid}#note_${r.id}` } : null
    case 'reply_to_discussion':
      return r.id ? { label: 'Réponse dans un fil', url: `${base}/merge_requests/${r.noteable_iid ?? ctx.mr_iid}#note_${r.id}` } : null
    case 'update_merge_request_description':
      return r.web_url ? { label: `Description de !${r.iid}`, url: r.web_url } : null
    case 'create_merge_request':
      return r.web_url ? { label: `Merge request !${r.iid}`, url: r.web_url } : null
    default:
      return null
  }
}
