'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { matchesAny, isWanted, globToRegExp } = require('../src/match');

describe('glob matcher', () => {
  it('matches * within and across levels for bare patterns', () => {
    assert.equal(matchesAny('a.log', ['*.log']), true);
    assert.equal(matchesAny('sub/deep/a.log', ['*.log']), true);
    assert.equal(matchesAny('a.txt', ['*.log']), false);
  });

  it('**/ crosses directories, */ does not', () => {
    assert.equal(matchesAny('sub/a.log', ['**/*.log']), true);
    assert.equal(matchesAny('a.log', ['**/*.log']), true);
    assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false);
    assert.equal(globToRegExp('src/*.js').test('src/a.js'), true);
  });

  it('supports ?, {a,b} and [abc]', () => {
    assert.equal(matchesAny('ab1.txt', ['ab?.txt']), true);
    assert.equal(matchesAny('ab12.txt', ['ab?.txt']), false);
    assert.equal(matchesAny('app.ts', ['*.{js,ts}']), true);
    assert.equal(matchesAny('app.css', ['*.{js,ts}']), false);
    assert.equal(matchesAny('file1.md', ['file[123].md']), true);
    assert.equal(matchesAny('file9.md', ['file[123].md']), false);
  });

  it('empty pattern list matches nothing for matchesAny', () => {
    assert.equal(matchesAny('a.js', []), false);
    assert.equal(matchesAny('a.js', null), false);
  });

  it('isWanted combines include and exclude', () => {
    assert.equal(isWanted('a.log', [], ['*.log']), false);
    assert.equal(isWanted('a.txt', [], ['*.log']), true);
    assert.equal(isWanted('a.js', ['src/**'], []), false);
    assert.equal(isWanted('src/a.js', ['src/**'], []), true);
    assert.equal(isWanted('src/a.min.js', ['src/**'], ['*.min.js']), false);
    assert.equal(isWanted('anything', [], []), true);
  });
});
