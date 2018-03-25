#!/usr/bin/env node
'use strict';

/**
 * Archive done Agenda jobs from `agendaJobs` collection by moving them
 * to `agendaJobsArchived` collection.
 *
 * Make sure this collection exists before running this! Script won't create it.
 *
 * Usage:
 *
 *  npm run agenda-maintenance
 *
 * To reverse ALL the documents from archive back to live db:
 *
 *  npm run agenda-maintenance -- reverse
 */

var MongoClient = require('mongodb').MongoClient,
    path = require('path'),
    chalk = require('chalk'),
    async = require('async'),
    config = require(path.resolve('./config/config'));

var dbConnection,
    sourceCollection,
    targetCollection,
    filter = { nextRunAt: null, lockedAt: null },
    total;

if (process.argv[2] === 'reverse') {
  console.log(chalk.red('🚨  Reverse action! Movind docs from archive back to live.'));
  // Archived → back to live
  var sourceCollectionName = 'agendaJobsArchived',
      targetCollectionName = 'agendaJobs';
} else {
  // From live to achived
  var sourceCollectionName = 'agendaJobs',
      targetCollectionName = 'agendaJobsArchived';
}

function countTotals(done) {
  sourceCollection.find().count().then(function (sourceCount) {
    console.log('\nSource count: ' + sourceCount);
    targetCollection.find().count().then(function (targetCount) {
      console.log('Target count: ' + targetCount);
      console.log('Total: ' + (sourceCount + targetCount) + '\n');
      done();
    });
  });
}

function moveDoc(doc, callback) {
  if (doc) {
    // Process doc
    insertDocument(doc, function (err) {
      if (err) {
        return callback(err);
      }
      removeDocument(doc, function (err) {
        if (err) {
          return callback(err);
        }
        callback(null);
      });
    });
  }
}


function insertDocument(doc, callback) {
  targetCollection.insertOne(doc, function (err, result) {
    callback(err, result);
  });
}


function removeDocument(doc, callback) {
  sourceCollection.deleteOne(doc, function (err, result) {
    callback(err, result);
  });
}



async.waterfall([

  // Connect
  function (done) {
    // Use connect method to connect to the server
    MongoClient.connect(config.db.uri, function (err, db) {
      if (err) {
        console.log(chalk.red('Could not connect to MongoDB!'));
        return done(err);
      }

      dbConnection = db;

      console.log(chalk.green('Connected to MongoDB:'), config.db.uri);

      sourceCollection = dbConnection.collection(sourceCollectionName),
      targetCollection = dbConnection.collection(targetCollectionName);

      done();
    });
  },

  // Count total
  function (done) {
    console.log('Counting docs...');
    sourceCollection.find(filter).count().then(function (count) {
      total = count;
      if (total <= 0) {
        console.log('No documents to transfer.');
        process.exit(0);
        return;
      }

      console.log('Going to move ' + total + ' documents from ' + sourceCollectionName + ' to ' + targetCollectionName + '\n');
      done();
    });
  },

  // Show how many docs each collection has currently
  function (done) {
    if (total <= 0) {
      return done();
    }
    countTotals(done);
  },

  // Fetch docs and get the cursor
  function (done) {
    if (total <= 0) {
      return done(null, null);
    }

    console.log('Fetching docs for transfer...\n');
    // cursor for streaming from mongoDB
    sourceCollection.find(filter, function (err, cursor) {
      done(null, cursor);
    });
  },

  // process docs
  function (cursor, done) {
    if (total <= 0) {
      if (cursor) {
        cursor.close().then(function () {
          done();
        });
        return;
      }
      return done();
    }

    console.log('Processing ' + total + ' docs...\n');

    // preparation for async.doWhilst function
    //
    // settings how often the progress will be printed to console
    // every PROGRESS_INTERVAL %
    var PROGRESS_INTERVAL = 0.1; // percent
    var keepGoing = true;
    var progress = 1; // progress counter

    // this is the test for async.doWhilst
    var testKeepGoing = function () {
      return keepGoing;
    };

    // here we process the doc and print progress sometimes
    function saveMessageAndRunCounter(doc, callback) {
      // updating the message stat
      moveDoc(doc, function (err) {
        if (err) {
          return callback(err);
        }

        // showing the progress sometimes
        if (progress % Math.ceil(total / 100 * PROGRESS_INTERVAL) === 0) {
          // update the progress instead of logging to newline
          var progressPercent = (progress / total * 100).toFixed(1);
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write(
            '~' + progressPercent + '% (' + progress + '/' + total + ')'
          );
        }
        ++progress;

        return callback();
      });
    }

    // the iteratee (function to run in each step) of async.doWhilst
    function processNext(callback) {
      // getting the next message from mongodb
      cursor.next(function (err, msg) {
        // We've passed the end of the cursor
        if (!msg) {
          console.log('\nDone with the queue');
          keepGoing = false;
          return callback();
        }

        if (err) {
          console.log('\nCursor.next error:');
          console.error(err);
          return callback(err);
        }

        saveMessageAndRunCounter(msg, callback);
      });
    }

    // callback for the end of the script
    function finish(err) {
      cursor.close().then(function () {
        return done(err, progress);
      });
    }

    async.doWhilst(processNext, testKeepGoing, finish);
  },

  // Show how many docs each collection has currently
  function (done, progress) {
    if (total <= 0) {
      return done();
    }
    countTotals(function () {
      done(null, progress);
    });
  }

], function (err, totalProcessed) {
  if (err) {
    console.log('\nFinal error:');
    console.error(err);
  }

  console.log('\n\n✨  Done ' + (totalProcessed || 0) + '/' + (total || 0) + ' documents.');

  // Disconnect
  if (dbConnection) {
    console.log('Closing db...');
    dbConnection.close().then(function (err) {
      if (err) {
        return console.log('\nFailed to disconnect DB');
      }
      console.log('\nDisconnected from MongoDB');
    });
  }

  process.exit(0);
});
