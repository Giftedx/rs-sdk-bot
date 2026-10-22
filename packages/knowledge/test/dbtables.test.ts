import { test, expect } from 'bun:test';
import { parseConfigs } from '../src/config';
import { buildDbTables } from '../src/dbtables';

const TABLE = `[woodcutting_trees]
column=levelrequired,int
column=tree,loc,LIST,INDEXED,REQUIRED
column=productexp,int
column=product,namedobj
`;
const ROWS = `[oak_tree_table]
table=woodcutting_trees
data=tree,oaktree
data=tree,oaktree2
data=levelrequired,15
data=productexp,375
data=product,oak_logs
`;

test('rows are grouped under their table, with list columns kept as lists and a src per value', () => {
    const t = buildDbTables(parseConfigs(TABLE, 'scripts/t.dbtable'), parseConfigs(ROWS, 'scripts/t.dbrow'));
    expect(t).toHaveLength(1);
    expect(t[0]!.table).toBe('woodcutting_trees');
    expect(t[0]!.columns.map(c => c.name)).toEqual(['levelrequired', 'tree', 'productexp', 'product']);
    const row = t[0]!.rows[0]!;
    expect(row.name).toBe('oak_tree_table');
    expect(row.data.tree).toEqual([['oaktree'], ['oaktree2']]);
    expect(row.data.levelrequired).toEqual([['15']]);
    expect(row.src.productexp).toEqual(['scripts/t.dbrow:6']);
});

test('a row whose table has no definition is kept under an unknown-columns table', () => {
    const t = buildDbTables([], parseConfigs('[r]\ntable=missing\ndata=a,1\n', 'x.dbrow'));
    expect(t[0]).toMatchObject({ table: 'missing', columns: [] });
    expect(t[0]!.rows[0]!.data.a).toEqual([['1']]);
});
