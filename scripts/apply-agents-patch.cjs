const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const patch = require('../patches/agents-4.0.1-mcp-recovery.json');
const hash = (text) => createHash('sha256').update(text).digest('hex');

/** Validate every input before writing; dependency drift must fail the installation. */
function applyPatch(root = path.resolve(__dirname, '../node_modules/@librechat/agents')) {
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (installed.name !== patch.package || installed.version !== patch.version) {
    throw new Error(`MCP recovery patch requires ${patch.package}@${patch.version}`);
  }
  const updates = patch.files.map((file) => {
    const target = path.join(root, file.path);
    const original = fs.readFileSync(target, 'utf8');
    if (hash(original) === file.afterSha256) {
      return null;
    }
    if (hash(original) !== file.beforeSha256) {
      throw new Error(`MCP recovery patch input mismatch: ${file.path}`);
    }
    let result = original;
    for (const edit of file.edits) {
      if (result.split(edit.before).length - 1 !== edit.count) {
        throw new Error(`MCP recovery patch context mismatch: ${file.path}`);
      }
      result = result.split(edit.before).join(edit.after);
    }
    if (hash(result) !== file.afterSha256) {
      throw new Error(`MCP recovery patch output mismatch: ${file.path}`);
    }
    return { target, result };
  });
  for (const update of updates) {
    if (update) fs.writeFileSync(update.target, update.result);
  }
}

module.exports = { applyPatch };
if (require.main === module) applyPatch();
