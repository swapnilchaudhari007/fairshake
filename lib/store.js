// Plain JSON file storage. Good enough for a prototype, swap for Postgres later.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'gigs.json');

let db = { gigs: {} };

function load() {
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!db.gigs) db.gigs = {};
  } catch {
    db = { gigs: {} };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

function list() {
  return Object.values(db.gigs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function get(id) {
  return db.gigs[id] || null;
}

function put(gig) {
  gig.updatedAt = new Date().toISOString();
  db.gigs[gig.id] = gig;
  save();
  return gig;
}

function log(gig, who, text, extra) {
  gig.timeline = gig.timeline || [];
  gig.timeline.push({ at: new Date().toISOString(), who, text, ...(extra || {}) });
}

load();

module.exports = { list, get, put, log, newId };
