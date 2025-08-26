const cloudinary = require('./cldnry');
// --- utilidades comunes ---
async function listSubfolders(path) {
  const out = [];
  let next_cursor = undefined;
  do {
    const r = await cloudinary.api.sub_folders(path, next_cursor ? { next_cursor } : {});
    (r.folders || []).forEach(f => out.push({ name: f.name, path: f.path || `${path}/${f.name}` }));
    next_cursor = r.next_cursor;
  } while (next_cursor);
  return out;
}

async function deleteByPrefixAllKinds(prefix) {
  const resourceTypes = ['image', 'video', 'raw'];
  const typesTry = ['authenticated', 'private', 'upload'];

  for (const resource_type of resourceTypes) {
    for (const type of typesTry) {
      try {
        await cloudinary.api.delete_resources_by_prefix(prefix, {
          resource_type,
          type,
          invalidate: true, // limpia CDN
        });
      } catch (e) {
        // ignoramos y probamos los otros type/resource_type
      }
    }
  }
}

async function tryDeleteFolder(path) {
  try { await cloudinary.api.delete_folder(path); } catch {}
}

// --- CHATS: borra chats/p_*/u_<uid> ---
async function deleteUserChatUploadsByFolder(uid) {
  const propFolders = await listSubfolders('chats'); // -> [{name:'p_48', path:'chats/p_48'}, ...]
  const target = `u_${uid}`;

  for (const pf of propFolders) {
    let subs = [];
    try { subs = await listSubfolders(pf.path); } catch {}
    const u = subs.find(s => s.name === target);
    if (!u) continue;

    const prefix = `${pf.path}/${target}`;    // chats/p_XX/u_<uid>
    await deleteByPrefixAllKinds(prefix);
    await tryDeleteFolder(prefix);

    // si p_* quedó vacío, intenta borrarlo
    let still = [];
    try { still = await listSubfolders(pf.path); } catch {}
    if (!still.length) await tryDeleteFolder(pf.path);
  }
}

// --- PROPIEDADES: borra listed/<env>/image/u_<uid> ---
function candidatePropertyImagePrefixes(uid) {
  const base = process.env.CLD_BASE_FOLDER || 'listed';
  const envFolder = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

  // cubrimos rutas históricas y envs potenciales
  const candidates = new Set([
    `${base}/${envFolder}/image/u_${uid}`,
    `${base}/image/u_${uid}`,    // por si hubo cargas sin /dev|/prod
    `${base}/dev/image/u_${uid}`,
    `${base}/prod/image/u_${uid}`,
  ]);
  return [...candidates];
}

async function deleteUserPropertyUploadsByFolder(uid) {
  const prefixes = candidatePropertyImagePrefixes(uid);

  for (const prefix of prefixes) {
    // borra todos los recursos bajo el prefijo
    await deleteByPrefixAllKinds(prefix);

    // intenta borrar la carpeta del usuario
    await tryDeleteFolder(prefix);

    // intenta borrar padres si quedaron vacíos (opcional)
    const parts = prefix.split('/'); // e.g. ['listed','dev','image','u_32']
    if (parts.length >= 3) {
      const parent = parts.slice(0, -1).join('/');       // listed/dev/image
      const grand  = parts.slice(0, -2).join('/');       // listed/dev
      try { 
        const sub = await listSubfolders(parent);
        if (!sub.length) await tryDeleteFolder(parent);
      } catch {}
      try {
        const sub2 = await listSubfolders(grand);
        if (!sub2.length) await tryDeleteFolder(grand);
      } catch {}
    }
  }
}

module.exports = {
  deleteUserChatUploadsByFolder,
  deleteUserPropertyUploadsByFolder,
  deleteByPrefixAllKinds,
  listSubfolders,
  tryDeleteFolder,
};
