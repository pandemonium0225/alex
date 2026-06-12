// Preloaded via NODE_OPTIONS="--require=./fix-readlink.js" (see package.json).
// This project lives on an exFAT drive, which has no symlinks. On exFAT,
// readlink fails with EISDIR, but Node tooling (webpack, Next.js) only
// handles EINVAL ("not a symlink"), which is what NTFS returns. Translate
// the error code so builds behave as they would on NTFS.
"use strict";
const fs = require("fs");

function einval(p) {
  return Object.assign(
    new Error(`EINVAL: invalid argument, readlink '${String(p)}'`),
    { errno: -4071, code: "EINVAL", syscall: "readlink", path: String(p) }
  );
}

const origReadlink = fs.readlink;
fs.readlink = function (path, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? undefined : options;
  return origReadlink.call(fs, path, opts, (err, result) => {
    if (err && err.code === "EISDIR") err = einval(path);
    cb(err, result);
  });
};

const origReadlinkSync = fs.readlinkSync;
fs.readlinkSync = function (path, options) {
  try {
    return origReadlinkSync.call(fs, path, options);
  } catch (err) {
    if (err && err.code === "EISDIR") throw einval(path);
    throw err;
  }
};

const origPromise = fs.promises.readlink;
fs.promises.readlink = async function (path, options) {
  try {
    return await origPromise.call(fs.promises, path, options);
  } catch (err) {
    if (err && err.code === "EISDIR") throw einval(path);
    throw err;
  }
};
