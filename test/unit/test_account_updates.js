/**
 * Test that modifications made by modifyAccount are reflected in the object
 * by the time the modification is reported as completed.
 *
 * The following things are tested elsewhere:
 * - Credential modifications
 * - Signature modifications
 **/

define(function(require, exports) {

var $tc = require('rdcommon/testcontext');
var $th_main = require('./resources/th_main');

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_account_updates' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('modifyAccount updates should be reflected', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse, restored: false }),
      eLazy = T.lazyLogger('account');

  var TEST_PARAMS = RT.envOptions;
  // Things that should be the same across all accounts.
  var modifyValues = {
    // defaults to 0
    syncInterval: 3600000,
    // defaults to true
    notifyOnNew: false,
    // defaults to true
    playSoundOnSend: false
  };
  // Things that can vary per account type
  if (TEST_PARAMS.type === 'activesync') {
    // defaults to 'auto'
    modifyValues.syncRange = '1w';
  }

  T.check('make sure the defaults are not already what we want', function() {
    var mailAccount = testUniverse.allAccountsSlice.items[0];
    var modifyKeys = Object.keys(modifyValues);
    modifyKeys.forEach(function(key) {
      var existing = mailAccount[key];
      var modifyTo = modifyValues[key];
      if (existing === modifyTo) {
        eLazy.error('default for ' + key + ' is the same as what we want to ' +
                    'modify it to! (' + existing + ')');
      }
    });
  });

  T.group('modify the account');
  testAccount.do_modifyAccount(modifyValues);

  T.group('verify the changes took');
  T.check('verify', eLazy, function() {
    var mailAccount = testUniverse.allAccountsSlice.items[0];
    var modifyKeys = Object.keys(modifyValues);
    modifyKeys.forEach(function(key) {
      var current = mailAccount[key];
      var modifyTo = modifyValues[key];
      eLazy.expect_namedValue(key, modifyTo);
      eLazy.namedValue(key, current);
    });
  });

  T.group('cleanup');
});

});
