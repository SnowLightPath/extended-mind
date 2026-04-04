const API = 'https://api.github.com';

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function getFile(env, path) {
  return getFileFromRepo(env, env.GITHUB_REPO, path);
}

export async function getFileFromRepo(env, repo, path) {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'extended-mind-worker',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`GitHub GET ${repo}/${path}: ${res.status}`);
    throw new Error('GitHub operation failed');
  }
  const data = await res.json();
  return { content: fromBase64(data.content), sha: data.sha };
}

export async function putFile(env, path, content, message, sha) {
  if (sha === undefined) {
    const existing = await getFile(env, path);
    sha = existing ? existing.sha : null;
  }
  const body = { message, content: toBase64(content) };
  if (sha) body.sha = sha;

  const res = await fetch(`${API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'extended-mind-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`GitHub PUT ${path}: ${res.status}`, errBody);
    throw new Error('GitHub operation failed');
  }
  return await res.json();
}
