import subprocess
from pathlib import Path

import pytest

from leaseq.sdk import TaskRegistry


@pytest.mark.parametrize('kind', ['bad kind', 'x' * 101, 'with\nnewline'])
def test_python_registry_rejects_api_incompatible_names_before_polling(kind):
    with pytest.raises(ValueError, match='kind'):
        TaskRegistry().task(kind)(lambda job, context: None)


def test_python_registry_caps_the_claim_filter():
    registry = TaskRegistry()
    for i in range(64):
        registry.task(f'valid.{i}')(lambda job, context: None)
    with pytest.raises(ValueError, match='64'):
        registry.task('one.too.many')(lambda job, context: None)


def test_node_worker_rejects_invalid_registry_even_before_an_aborted_poll():
    root = Path(__file__).resolve().parents[1]
    source = """
const assert = require('node:assert/strict');
const {runWorker} = require('./sdks/node');
(async () => {
  const signal = AbortSignal.abort();
  const client = {claim() { throw new Error('must not call the API'); }};
  const invalid = [{'bad kind': () => {}}, {['with'+String.fromCharCode(10)+'newline']: () => {}}, {['x'.repeat(101)]: () => {}},
    Object.fromEntries(Array.from({length:65},(_,i)=>['kind.'+i,()=>{}])), {'valid': 1}];
  for (const handlers of invalid) await assert.rejects(runWorker(client,'unit',handlers,{signal}), /kind|handler|64/);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
"""
    result = subprocess.run(['node', '-e', source], cwd=root, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
