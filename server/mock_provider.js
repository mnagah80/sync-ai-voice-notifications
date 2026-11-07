'use strict';
// Mock call provider (Stage A). It places NO call and contacts NO network: it only records what a real
// provider would have been asked to say, so the whole journey can be tested end to end for $0.
// A real provider (Stage B, needs the owner's approval) must implement the same place() contract.
const crypto = require('crypto');

function createMockProvider() {
  return {
    name: 'mock',
    // returns { ref, status } — the core stores the call; the mock "answers" immediately.
    async place({ to, message }) {
      if (!/^\+1\d{3}55501\d{2}$/.test(to)) throw new Error('mock provider: only fictional test numbers');
      return { ref: 'mock_' + crypto.randomBytes(6).toString('hex'), status: 'completed' };
    },
  };
}
module.exports = { createMockProvider };
