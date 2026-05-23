const { getMemberServerTagId } = require('./memberTag');

const tests = [
  { name: 'guild_tag object with id', input: { guild_tag: { id: 'tag-123' } }, expected: 'tag-123' },
  { name: 'guild_tag string', input: { guild_tag: 'tag-xyz' }, expected: 'tag-xyz' },
  { name: 'avatar_decoration_data.id', input: { avatar_decoration_data: { id: 'dec-1' } }, expected: 'dec-1' },
  { name: 'user.avatar_decoration_data.tag_id', input: { user: { avatar_decoration_data: { tag_id: 't-9' } } }, expected: 't-9' },
  { name: 'clan object id', input: { clan: { id: 'clanA' } }, expected: 'clanA' },
  { name: 'tag_id field present', input: { tag_id: 'my-tag' }, expected: 'my-tag' },
  { name: 'tag in nested key name', input: { some_field: 'ignore', custom_tag: 'abc' }, expected: 'abc' },
  { name: 'no tag', input: { user: { id: 'u1', username: 'bob' } }, expected: null },
];

let failed = 0;
for (const t of tests) {
  const got = getMemberServerTagId(t.input);
  const pass = (got === t.expected);
  console.log(`${pass ? 'OK ' : 'FAIL'} - ${t.name} => got: ${JSON.stringify(got)}, expected: ${JSON.stringify(t.expected)}`);
  if (!pass) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
  process.exit(0);
}
