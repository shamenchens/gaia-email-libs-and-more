/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * IMAP folder synchronization logic.
 **/

define(
  [
    'q',
    'exports'
  ],
  function(
    $Q,
    exports
  ) {
'use strict';
const when = $Q.when;

/**
 * The maximum number of UIDs to think about batching up at one time.
 */
const MAX_UIDS_TO_CONSIDER = 256;


/**
 * Folder synchronization logic.  Currently each instance is responsible for
 * exactly one folder at a time with a maximum of one instance allowed per
 * folder.  In the future (once IMAP NOTIFY support is implemented by servers),
 * an instance may be responsible for more than one folder concurrently.
 *
 * All database manipulation and the like is done in tasks defined in
 * `lstasks.js`.  For now, every task runs with `LocalStore`s single mutex.  In
 * the future, more granular mutexes may be used for conversation creation /
 * mapping and for specific conversations to allow more parallelism in
 * synchronization.
 *
 * Our deletion model is that once a message has the \Deleted flag, it is gone;
 * we do not wait for it to be expunged.  In the event the \Deleted flag gets
 * removed before an expunge, we will simply consider the message anew when we
 * go to look it up by its UID and discover that we don't know about it.  We do
 * not attempt to optimize for that special case.
 */
function ImapFolderSyncer(conn, db) {
  this._conn = conn;
  this._db = db;

  this._folderName = null;
  /**
   * @typedef[IMAPFolderState @dict[
   *   @key[dbUIDNext Number]{
   *     The "UIDNEXT" we were told about last time we synchronized.  The
   *     change between this and the UIDNEXT of the current folder entry lets
   *     us determine the upper bound of new messages.
   *   }
   *   @key[dbUIDValidity]{
   *     The UID validity the folder had the last time we synchronized the
   *     database.  This gets updated once we have fully synchronized a folder.
   *   }
   *   @key[dbModSeq]{
   *     The MODSEQ for this folder that our database is up-to-date with.  This
   *     only gets updated once we have fully synchronized a folder (and then it
   *     is updated to the HIGHESTMODSEQ of the folder as of when we entered it.)
   *   }
   *   @key[firstUnprocessedMutationId Number]{
   *     The identifier for the first mutation we have yet to process.  If this
   *     is the same as nextMutationId, there are no mutations to process.
   *   }
   *   @key[nextMutationId Number]{
   *     The next identifier to use when adding message mutations to this
   *     folder.
   *   }
   * ]]
   */
  this._folderState = null;
  /**
   * @dict[
   *   @key[uidNext]
   *   @key[uidValidity]
   *   @key[highestModSeq]
   * ]{
   *   The state of the mailbox when we entered it for synchronization purposes.
   *   This gets updated each time we issue a new QRESYNC for this folder.
   * }
   */
  this._boxEntryState = null;

  /**
   * @oneof[
   *   @case["nofolder"]{
   *     We have not been requested to synchronize anything; we are not in a
   *     folder.
   *   }
   *   @case["enter"]{
   *     We are entering a folder.
   *   }
   *   @case["process"]{
   *     We are in a processing state where we repeatedly call _scheduleTask
   *     until it runs out of things to do and transitions us to "idle" or
   *     re-enters "enter" state because we were dirty.
   *   }
   *   @case["idle"]{
   *     We are synchronized with the folder's state and are issuing an IDLE
   *     command to receive notifications of updates to the folder.
   *   }
   * ]
   */
  this._syncState = 'nofolder';

  /**
   * The list of deleted UIDs, processed last-to-first for efficiency.
   */
  this._deletedUIDs = null;
  /**
   * @listof[@dict[
   *   @key[uid]
   *   @key[flags @listof[String]]{
   *     The set of flags/keywords on the message as of the notification.
   *   }
   *   @key[modseq String]{
   *     The modification sequence associated with this state.
   *   }
   * ]]{
   *   A list of messages with modified flags/keywords to have our persisted
   *   state updated if we know about them.  Messages with the \Deleted flag
   *   present are never added to this list, but instead added to the
   *   `_deletedUIDs` list.
   * }
   */
  this._flagChanges = null;
  /**
   * A list of UIDs to fetch for ingestion.  Messages only get in here after
   *  a search with our interesting predicates, so there should be no subsequent
   *  filtering required.
   */
  this._fetchUIDs = null;
  /**
   * @list[@param[lowUIDInclusive] @param[highUIDInclusive]]{
   *   A range of UIDs that we need to filter for new, interesting messages by
   *   using a SEARCH command with the goal of ingesting the winners.
   * }
   */
  this._filterNewUIDRange = null;
  /**
   * @listof[@list[
   *   @param[earlierDate #:optional]{
   *     If not present, the constraint is omitted, causing the time range to
   *     start at the dawn of (UNIX) time.
   *   }
   *   @param[laterDate]
   * ]]{
   *   A list of date-ranges to search for interesting UIDs and then contribute
   *   to _fetchUIDs for ingestion.
   * }
   */
  this._dateRanges = null;

  /**
   * Are we expecting to hear about any state mutations from the server right
   * now?  If we are not, then we ignore events we here and set `_folderDirty`.
   * Note that the IMAP standard does specify when it's legal for unsolicited
   * data to be thrown at us and so this guard is mainly to keep us sane and
   * eliminating a whole swathe of potential hypothetical situations when
   * debugging.
   */
  this._expectingChanges = false;
  /**
   * Do we believe that there have been changes in the folder since our last
   * call to QRESYNC?  Specifically, should we issue another QRESYNC immediately
   * once we deal with this one?
   */
  this._folderDirty = false;

  this._activeTask = null;
}
exports.ImapFolderSyncer = ImapFolderSyncer;
ImapFolderSyncer.prototype = {
  /**
   * Select the given folder using QRESYNC if previously syncronized, otherwise
   * initiating initial synchronization of the folder.  Fulfills the returned
   * promise once complete and then enters IDLE mode to receive updates.
   */
  syncFolder: function(folderName, folderState) {
    this._folderName = folderName;
    this._folderState = folderState;

    this._deletedUIDs = [];
    this._flagChanges = [];
    this._fetchUIDs = [];
    this._dateRanges = null;

    // - issue an initial sync or qresync as appropriate
    if (!this._folderState) {
      this._initialSync();
    }
    else {
      this._qresync();
    }
  },

  /**
   * Create a new task to work off the stuff we have to do per: `_deletedUIDs`,
   *  `_flagChanges`, `_fetchUIDs`, `+filterNewUIDRange`, and `_dateRanges`, in
   *  that order.  We are favoring a simple/straightforward processing idiom
   *  over a more complicated series of processing loops chained together using
   *  promises for now.
   */
  _scheduleTask: function() {
    var lowUID, highUID, uid;
    if (this._activeTask)
      throw new Error("We already have an active task!");

    if (this._deletedUIDs.length) {
    }

    if (this._flagChanges.length) {
    }

    if (this._fetchUIDs.length) {
      this._fetchAndIngestMessage(this._fetchUIDs.pop());
      return;
    }

    if (this._filterNewUIDRange) {
      lowUID = this._filterNewUIDRange[0];
      highUID = Math.min(this._filterNewUIDRange[1],
                         lowUID + MAX_UIDS_TO_CONSIDER);
      if (highUID >= this._filterNewUIDRange[1])
        this._filterNewUIDRange = null;
      else
        this._filterNewUIDRange[0] = highUID + 1;
      this._filterUIDRangeForInterestingMessages(lowUID, highUID);
      return;
    }

    if (this._dateRanges && this._dateRanges.length) {
      var dateRange = this._dateRanges.pop();
      this._syncMessagesInDateRange(dateRange[0], dateRange[1]);
      return;
    }
  },

  _initialSync: function() {
    var self = this;
    // - enter the folder, making note of the sync state for persistence
    this._syncState = 'enter';

    this._conn.openBox(this._folderName, true,
      function(err, box) {
        self._boxEntryState = {
          uidNext: box._uidnext,
          uidValidity: box.validity,
          highestModSeq: box.highestModSeq,
        };

        // Start the ingestion process by creating date ranges.
        self._dateRanges = self._generateDateSearchRanges();

        self._activeTask = null;
        self._scheduleTask();
      });
  },

  _qresync: function() {
    var self = this;
    // - enter the folder using QRESYNC
    this._syncState = 'enter';
    this._conn.qresyncBox(
      this._folderName, true,
      this._folderState.dbUIDValidity, this._folderState.dbModSeq,
      null,
      function(err, box) {
        self._boxEntryState = {
          uidNext: box._uidnext,
          uidValidity: box.validity,
          highestModSeq: box.highestModSeq,
        };
        // _deletedUIDS and _flagChanges should now contain a bunch of work for
        //  us to process.  However we still need to note the new UID range that
        //  we need to potentially process.
        if (self._folderState.dbUIDNext < self._boxEntryState.uidNext) {
          self._filterNewUIDRange = [self._folderState.dbUIDNext,
                                     self._boxEntryState.uidNext - 1];
        }

        self._activeTask = null;
        self._scheduleTask();
      });
  },


  /**
   * Our canned definition of what makes messages interesting APART FROM DATE.
   */
  _interestingSearchOptions: [
    '!DRAFT',
  ],

  /**
   * Create inclusive date ranges to search for messages with the goal of
   * starting the processing today and moving backwards in time.  Our goal is
   * to try and get a "reasonable" number of UIDs with each query while not
   * generating inefficent churn for the IMAP server to meet that goal.  If we
   * had a way to say "BEFORE somedate ORDER BY -date LIMIT", that would be our
   * dream, but we don't.  We can issue a COUNT, but the IMAP server has quite
   * likely already done all the work when it tells us that which is why we
   * don't use that.
   *
   * Our strategy is to generate 2 intervals per month and stay away from Feb
   * 29th because it's just not worth it.  So our ranges look like:
   * [March 2-March 15, Feb 16-March 1, Feb 2-Feb15, ...].  We do this for
   * 2 years worth, then we just give up and use an open-ended range before
   * that.  That obviously sucks, but a more reasonable full-sync approach
   * is just to use the dates to fill-in initially and then just do UID range
   * scanning (backwards), and we can do that next.
   */
  _generateDateSearchRanges: function() {
    // The start of the list will be now, the end of the list will be the dawn
    // of time.  We'll flip that when we return it so that we can use pop() to
    // get ranges while moving backwards in time.
    var dateRanges = [], today = new Date(),
        // For simplicity, just start with the latter half of the current month,
        // even if leaves us with a range completely in the future.
        year = today.getFullYear() + ((today.getMonth() === 11) ? 1 : 0),
        month = (today.getMonth() + 1) % 12,
        latterHalf = true;
    for (var count = 25; count > 0; count--) {
      var laterDate = new Date(year, month, (latterHalf ? 1 : 15));
      if (latterHalf) {
        if (--month < 0) {
          month += 12;
          year--;
        }
      }
      var earlierDate = new Date(year, month, (latterHalf ? 16: 2));
      latterHalf = !latterHalf;

      dateRanges.push([earlierDate, laterDate]);
    }

    // Open-ended into the future (let's hope the aren't a lot of ridiculous
    // spam messages.
    dateRanges[0][1] = null;
    dateRanges.reverse();
    // Open-ended into the past.
    dateRanges[0][0] = null;
    return dateRanges;
  },

  /**
   * Initiate synchronization of messages given an inclusive data range.  This
   * is intended to be used to perform initial synchronization in a useful
   * fashion (recent stuff is more likely to be interesting) and to support
   * partial synchronization of only a recent time horizon (possibly augmented
   * by interest factors.)  Also, to some extent we want to avoid having a huge
   * number of UIDs in memory at a time (not that they take up a huge amount of
   * memory.) This function is intended to be used by a higher level function.
   */
  _syncMessagesInDateRange: function(earlierDate, laterDate) {
    var searchOptions = this._interestingSearchOptions.concat(), self = this;
    this._activeTask = 'syncMessagesInDateRange';
    if (earlierDate)
      searchOptions.push(['SINCE', earlierDate]);
    if (laterDate)
      searchOptions.push(['BEFORE', laterDate]);
    this._conn.search(searchOptions, function(err, uids) {
        self._fetchUIDs = self._fetchUIDs.concat(uids);
        self._activeTask = null;
        self._scheduleTask();
      });
  },

  /**
   * Run a SEARCH against a specific UID range to figure out the messages in
   *  that range that are interesting to us.
   */
  _filterUIDRangeForInterestingMessages: function(lowUID, highUID) {
    this._activeTask = 'filterUIDRangeForInterestingMessages';
    var searchOptions = this._interestingSearchOptions.concat(), self = this;
    searchOptions.push(['UID', lowUID + ':' + highUID]);
    this._conn.search(searchOptions, function(err, uids) {
        self._fetchUIDs = self._fetchUIDs.concat(uids);
        self._activeTask = null;
        self._scheduleTask();
      });
  },

  /**
   * Fetch parameters to get the headers / bodystructure; exists to reuse the
   *  object since every fetch is the same.  Note that imap.js always gives us
   *  FLAGS and INTERNALDATE so we don't need to ask for that.
   */
  INITIAL_FETCH_PARAMS: {
    request: { headers: true, struct: true },
  },

  /**
   * Two-pass fetching: 1) get the headers and bodystructure, 2) figure out from
   *  the bodystructure what body parts we need to be able to display the
   *  message to the user and fetch those.  The extra roundtrip is undesirable
   *  from a latency perspective, but so is our one-by-one processing; we can
   *  move to more aggressive batching once things are working nicely.
   */
  _fetchAndIngestMessage: function(uid) {
    this._activeTask = 'fetchAndIngest:' + uid;
    var self = this;
    // -- Get headers and body-structure!
    var fetcher = this._conn.fetch(uid, this.INITIAL_FETCH_PARAMS);
    fetch.on('message', function onMessage(msg) {
      msg.on('end', function onMsgEnd() {

      });
    });
    // - Error
    // Presumably an error is due to the UID no longer existing, in which
    //  case the correct course of action is for us to just move on to the
    //  next task.  We only fetch messages we don't know about yet for this
    //  code path, so it failing to exist does not leave any orphaned state.
    fetch.on('error', function onFetchError(err) {
      console.error("Fetch error:", err);
      self._activeTask = null;
      self._scheduleTask();
    });
  },

  /**
   * Second pass of ingestion fetching: get the effective body given that we
   *  know the bodystructure.
   *
   * For now, our stop-gap heuristics for content bodies are:
   * - pick text/plain in multipart/alternative
   * - recurse into other multipart types looking for an alterntive that has
   *    text.
   * - do not recurse into message/rfc822
   * - ignore/fail-out messages that lack a text part, skipping to the next
   *    task.  (This should not happen once we support HTML, as there are cases
   *    where there are attachments without any body part.)
   * - Append text body parts together; there is no benefit in separating a
   *    mailing list footer from its content.
   *
   * For attachments, our heuristics are:
   * - only like them if they have filenames.  We will find this as "name" on
   *    the "content-type" or "filename" on the "content-disposition", quite
   *    possibly on both even.  For imap.js, "name" shows up in the "params"
   *    dict, and filename shows up in the "disposition" dict.
   * - ignore crypto signatures, even though they are named.  S/MIME gives us
   *    "smime.p7s" as an application/pkcs7-signature under a multipart/signed
   *    (that the server tells us is "signed").  PGP in MIME mode gives us
   *    application/pgp-signature "signature.asc" under a multipart/signed.
   *
   * The next step in the plan is to get an HTML sanitizer exposed so we can
   *  support text/html.  That will also imply grabbing multipart/related
   *  attachments.
   */
  _fetchBodyAndProcess: function(msg) {
    // imap.js builds a bodystructure tree using lists.  All nodes get wrapped
    //  in a list so they are element zero.  Children (which get wrapped in
    //  their own list) follow.
    //
    // Examples:
    //   text/plain =>
    //     [{text/plain}]
    //   multipart/alternative with plaintext and HTML =>
    //     [{alternative} [{text/plain}] [{text/html}]]
    //   multipart/mixed text w/attachment =>
    //     [{mixed} [{text/plain}] [{application/pdf}]]

    /**
     * Sizes are the size of the encoded string, not the decoded value.
     */
    function estimatePartSizeInBytes(partInfo) {
      var encoding = partInfo.encoding;
      // Base64 encodes 3 bytes in 4 characters with padding that always
      // causes the encoding to take 4 characters.  The max encoded line length
      // (ignoring CRLF) is 76 bytes, with 72 bytes also fairly common.
      // As such, a 78=19*4+2 character line encodes 57=19*3 payload bytes and
      // we can use that as a rough estimate.
      if (encoding === 'base64') {
        return Math.floor(partInfo.size * 57 / 78);
      }
      // Quoted printable is hard to predict since only certain things need
      // to be encoded.  It could be perfectly efficient if the source text
      // has a bunch of newlines built-in.
      else if (encoding === 'quoted-printable') {
        // Let's just provide an upper-bound of perfectly efficient.
        return partInfo.size;
      }
      // No clue; upper bound.
      return partInfo.size;
    }

    function chewStruct(branch) {
      var partInfo = branch[0], bodyPartIds = [], attachments = [], i,
          filename;

      // - Detect named parts; they could be attachments
      if (partInfo.params && partInfo.params.name)
        filename = partInfo.params.name;
      else if (partInfo.disposition && partInfo.disposition.filename)
        filename = partInfo.disposition.filename;
      else
        filename = null;

      // - But we don't care if they are signatures...
      if ((type === 'application') &&
          (subtype === 'pgp-signature' || subtype === 'pkcs7-signature'))
        return;

      // - Attachments have names and don't have id's for multipart/related
      if (filename && !partInfo.id) {
        attachments.push({
          name: filename,
          part: partInfo.partID,
          sizeEstimate: estimatePartSizeInBytes(partInfo),
        });
        return;
      }
      // XXX once we support html we need to save off the related bits.

      // - We must be an inline part or structure
      switch (partInfo.type) {
        // - content
        case 'text':
          if (partInfo.subtype === 'plain') {
            bodyPartIds.push(partInfo.partID);
          }
          // (ignore html)
          break;

        // - multipart that we should recurse into
        case 'alternative':
        case 'mixed':
        case 'signed':
          for (i = 1; i < branch.length; i++) {
            chewStruct(branch[i]);
          }
          break;
      }
      // - ignored
    }
    chewStruct(msg.structure);
  },

  /**
   * Tells us about deleted message UIDs.
   */
  _onVanished: function(uids, happenedEarlier) {
    if (!this._expectingChanges) {
      this._folderDirty = true;
      return;
    }

    this._deletedUIDs = uids.concat(this._deletedUIDs);
    if (!this._activeTask)
      this._scheduleTask();
  },

  /**
   * Keyword updates.
   */
  _onMsgUpdate: function(msg) {
    if (!this._expectingChanges) {
      this._folderDirty = true;
      return;
    }

    if (msg.flags.indexOf('\\Deleted') !== -1)
      this._deletedUIDs.push(msg.id);
    else
      this._flagChanges.push({
          uid: msg.id,
          flags: msg.flags,
        });
    if (!this._activeTask)
      this._scheduleTask();
  },


};

}); // end define
