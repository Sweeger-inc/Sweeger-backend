const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const hasSupabaseConfig =
  Boolean(process.env.SUPABASE_URL) && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

let supabase;

if (hasSupabaseConfig) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} else {
  console.warn(
    '[AI Studio] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured — using in-memory Supabase stub'
  );

  // In-memory store per table (data lost on restart)
  const tables = new Map();

  const getTable = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  const evaluateClause = (row, clause) => {
    const trimmed = clause.trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(4, -1);
      const parts = splitTopLevelCommas(inner);
      return parts.every((p) => evaluateClause(row, p));
    }
    const firstDot = trimmed.indexOf('.');
    if (firstDot === -1) return false;
    const col = trimmed.slice(0, firstDot);
    const rest = trimmed.slice(firstDot + 1);
    const secondDot = rest.indexOf('.');
    if (secondDot === -1) return false;
    const op = rest.slice(0, secondDot);
    const val = rest.slice(secondDot + 1);

    if (op === 'eq') return String(row[col]) === val;
    if (op === 'neq') return String(row[col]) !== val;
    if (op === 'is' && val === 'null') return row[col] === null || row[col] === undefined;
    return false;
  };

  const splitTopLevelCommas = (str) => {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  };

  class InMemoryQuery {
    constructor(tableName) {
      this.tableName = tableName;
      this.operation = 'select';
      this.filters = [];
      this.payload = null;
      this.upsertConflict = null;
      this.orderBy = null;
      this.limitCount = null;
      this.rangeBounds = null;
      this.headOnly = false;
      this.wantCount = false;
      this.singleMode = null; // 'single' | 'maybeSingle' | null
      this.selectSpec = '*';
    }

    select(columns = '*', opts = {}) {
      this.selectSpec = columns;
      if (opts && opts.count === 'exact') this.wantCount = true;
      if (opts && opts.head) this.headOnly = true;
      return this;
    }

    insert(rows) {
      this.operation = 'insert';
      this.payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }

    upsert(rows, opts = {}) {
      this.operation = 'upsert';
      this.payload = Array.isArray(rows) ? rows : [rows];
      this.upsertConflict = opts?.onConflict || null;
      return this;
    }

    update(patch) {
      this.operation = 'update';
      this.payload = patch;
      return this;
    }

    delete() {
      this.operation = 'delete';
      return this;
    }

    eq(col, val) {
      this.filters.push((row) => row[col] === val);
      return this;
    }

    neq(col, val) {
      this.filters.push((row) => row[col] !== val);
      return this;
    }

    lt(col, val) {
      this.filters.push((row) => row[col] < val);
      return this;
    }

    lte(col, val) {
      this.filters.push((row) => row[col] <= val);
      return this;
    }

    gt(col, val) {
      this.filters.push((row) => row[col] > val);
      return this;
    }

    gte(col, val) {
      this.filters.push((row) => row[col] >= val);
      return this;
    }

    ilike(col, pattern) {
      const regex = new RegExp(
        '^' +
          String(pattern)
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.') +
          '$',
        'i'
      );
      this.filters.push((row) => row[col] != null && regex.test(String(row[col])));
      return this;
    }

    in(col, vals) {
      const set = new Set(vals || []);
      this.filters.push((row) => set.has(row[col]));
      return this;
    }

    is(col, val) {
      this.filters.push((row) => (val === null ? row[col] == null : row[col] === val));
      return this;
    }

    or(expr) {
      const clauses = splitTopLevelCommas(String(expr));
      this.filters.push((row) => clauses.some((clause) => evaluateClause(row, clause)));
      return this;
    }

    order(col, { ascending = true } = {}) {
      this.orderBy = { col, ascending };
      return this;
    }

    limit(n) {
      this.limitCount = n;
      return this;
    }

    range(from, to) {
      this.rangeBounds = [from, to];
      return this;
    }

    single() {
      this.singleMode = 'single';
      return this._execute();
    }

    maybeSingle() {
      this.singleMode = 'maybeSingle';
      return this._execute();
    }

    then(resolve, reject) {
      return this._execute().then(resolve, reject);
    }

    _enrichRelations(row) {
      const copy = { ...row };
      const users = getTable('users');
      const findUser = (id) => users.find((u) => u.id === id) || null;

      if (this.selectSpec.includes('users!rooms_host_id_fkey') || (this.tableName === 'rooms' && this.selectSpec.includes('users'))) {
        copy.users = findUser(row.host_id);
      }
      if (this.tableName === 'room_participants' && this.selectSpec.includes('users')) {
        copy.users = row.user_id ? findUser(row.user_id) : null;
      }
      if (this.tableName === 'watch_mate_members' && this.selectSpec.includes('users')) {
        copy.users = findUser(row.user_id);
      }
      if (this.tableName === 'watch_mate_pods' && this.selectSpec.includes('watch_mate_members')) {
        copy.watch_mate_members = getTable('watch_mate_members').filter(
          (m) => m.pod_id === row.id && m.is_active
        );
      }
      if (this.tableName === 'follows') {
        if (this.selectSpec.includes('following_id')) {
          copy.users = findUser(row.following_id);
        }
        if (this.selectSpec.includes('follower_id') && this.selectSpec.includes('follows_follower_id_fkey')) {
          copy.users = findUser(row.follower_id);
        }
      }
      if (this.tableName === 'poddy_relationships') {
        if (this.selectSpec.includes('requester')) copy.requester = findUser(row.requester_id);
        if (this.selectSpec.includes('receiver')) copy.receiver = findUser(row.receiver_id);
      }
      return copy;
    }

    async _execute() {
      const rows = getTable(this.tableName);
      const matchesFilters = (row) => this.filters.every((fn) => fn(row));
      const now = new Date().toISOString();

      let resultRows = [];

      if (this.operation === 'insert') {
        const inserted = this.payload.map((item) => {
          const record = {
            id: item.id || uuidv4(),
            created_at: item.created_at || now,
            updated_at: item.updated_at || now,
            ...item,
          };
          rows.push(record);
          return this._enrichRelations(record);
        });
        resultRows = inserted;
      } else if (this.operation === 'upsert') {
        const conflictCols = this.upsertConflict
          ? this.upsertConflict.split(',').map((c) => c.trim())
          : ['id'];
        const upserted = this.payload.map((item) => {
          const idx = rows.findIndex((existing) =>
            conflictCols.every((c) => existing[c] !== undefined && existing[c] === item[c])
          );
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...item, updated_at: now };
            return this._enrichRelations(rows[idx]);
          }
          const record = {
            id: item.id || uuidv4(),
            created_at: item.created_at || now,
            updated_at: item.updated_at || now,
            ...item,
          };
          rows.push(record);
          return this._enrichRelations(record);
        });
        resultRows = upserted;
      } else if (this.operation === 'update') {
        for (let i = 0; i < rows.length; i++) {
          if (matchesFilters(rows[i])) {
            rows[i] = { ...rows[i], ...this.payload, updated_at: now };
            resultRows.push(this._enrichRelations(rows[i]));
          }
        }
      } else if (this.operation === 'delete') {
        const remaining = [];
        for (const r of rows) {
          if (matchesFilters(r)) {
            resultRows.push(this._enrichRelations(r));
          } else {
            remaining.push(r);
          }
        }
        tables.set(this.tableName, remaining);
      } else {
        resultRows = rows.filter(matchesFilters).map((r) => this._enrichRelations(r));
      }

      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        resultRows.sort((a, b) => {
          if (a[col] === b[col]) return 0;
          if (a[col] === undefined || a[col] === null) return 1;
          if (b[col] === undefined || b[col] === null) return -1;
          return (a[col] < b[col] ? -1 : 1) * (ascending ? 1 : -1);
        });
      }

      const totalCount = resultRows.length;

      if (this.rangeBounds) {
        const [from, to] = this.rangeBounds;
        resultRows = resultRows.slice(from, to + 1);
      }
      if (typeof this.limitCount === 'number') {
        resultRows = resultRows.slice(0, this.limitCount);
      }

      if (this.singleMode === 'single') {
        const row = resultRows[0] || null;
        return row
          ? { data: row, error: null, count: this.wantCount ? totalCount : null }
          : { data: null, error: { message: 'Row not found', code: 'PGRST116' }, count: null };
      }

      if (this.singleMode === 'maybeSingle') {
        return {
          data: resultRows[0] || null,
          error: null,
          count: this.wantCount ? totalCount : null,
        };
      }

      return {
        data: this.headOnly ? null : resultRows,
        error: null,
        count: this.wantCount ? totalCount : null,
      };
    }
  }

  supabase = {
    from: (table) => new InMemoryQuery(table),
    rpc: async () => ({ data: null, error: null }),
    __isStub: true,
    __resetStub: () => tables.clear(),
  };
}

module.exports = supabase;