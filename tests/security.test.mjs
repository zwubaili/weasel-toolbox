import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

// Match the options used when discovering local Rime configuration.
const options = { uniqueKeys: true, maxAliasCount: 50 };

test('深层 YAML 输入被解析器拒绝，不发生调用栈溢出', () => {
  // Regression for GHSA-48c2-rrv3-qjmp: about 10 KB, below the config size cap.
  const input = '['.repeat(5000) + '1' + ']'.repeat(5000);
  assert.throws(() => YAML.parse(input, options), error => {
    assert.ok(error instanceof YAML.YAMLParseError);
    assert.ok(!(error instanceof RangeError));
    return true;
  });
});

test('安全升级后仍能读取普通 Rime 方案配置', () => {
  const parsed = YAML.parse('schema_list:\n  - schema: wubi_pinyin\nschema:\n  name: 五笔·拼音\ntranslator:\n  dictionary: wubi86\n', options);
  assert.deepEqual(parsed.schema_list, [{ schema: 'wubi_pinyin' }]);
  assert.equal(parsed.schema.name, '五笔·拼音');
  assert.equal(parsed.translator.dictionary, 'wubi86');
});
