export async function handleWebhook(request, env) {
  const payload = await request.json();
  const commits = payload.commits || [];
  const changedFiles = commits.flatMap((c) => [...(c.added || []), ...(c.modified || [])]);
  const sourceRepo = payload.repository?.full_name;

  const results = [];

  if (changedFiles.includes('seed/core.yaml') && sourceRepo) {
    const { getFileFromRepo } = await import('../services/github.js');
    const file = await getFileFromRepo(env, sourceRepo, 'seed/core.yaml');
    if (file) {
      await env.PCP.put('core', file.content);
      await env.PCP.put('_core_sha', file.sha);
      results.push('core synced');
    }
  }

  if (changedFiles.includes('seed/active.json') || changedFiles.includes('active.json')) {
    const repo = sourceRepo || env.GITHUB_REPO;
    const { getFileFromRepo } = await import('../services/github.js');
    let file = await getFileFromRepo(env, repo, 'active.json');
    if (!file) file = await getFileFromRepo(env, repo, 'seed/active.json');
    if (file) {
      await env.PCP.put('active', file.content);
      results.push('active synced');
    }
  }

  console.log('Webhook:', results.length > 0 ? results.join(', ') : 'no relevant changes');
  return new Response(JSON.stringify({ ok: true, synced: results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
