/*
  The MIT License (MIT)

  Copyright (c) 2015 Christian Adam

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

/**
  @overview Provides a module that let's you interact with Artifactory API
  @author Christian Adam
  @author Maarten Haubrich
*/

var _ = require('underscore'),
  Q = require('q'),
  request = require('request'),
  path = require('path'),
  fs = require('fs'),
  md5File = require('md5-file'),
  nodeStream = require('stream');

/**
  Creates a new Artifactory API instance
  @class
*/
function ArtifactoryAPI(url, auth) {
  this.url_ = url;
  this.auth_ = auth;
}

/**
  @prop {object} API - General API sections
  @static
*/
ArtifactoryAPI.API = {
  storage: '/artifactory/api/storage/',
  build: '/artifactory/api/build'
};

/**
  @prop {object} ACTIONS - The ACTIONS listed here represent well-known paths for
  common artifactory actions.
  @static
*/
ArtifactoryAPI.ACTIONS = {
  'getFileInfo': ArtifactoryAPI.API.storage + '<%= repoKey %><%= filePath %>',
  'filePath': '/artifactory/' + '<%= repoKey %><%= filePath %>'
};

/** Get file info from Artifactory server. The result is provided in a json object.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo.
 * @returns {object} A QPromise to a json object with the file's info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-FileInfo|FileInfo} Artifactory API.
 */
ArtifactoryAPI.prototype.getFileInfo = function (repoKey, remotePath) {
  var deferred = Q.defer();

  var compiled = _.template(ArtifactoryAPI.ACTIONS.getFileInfo);

  var actionPath = compiled({
    repoKey : repoKey,
    filePath: remotePath
  });

  var options = {
    url      : this.url_ + actionPath,
    headers  : this._getAuthHeaders(),
    strictSSL: false
  };

  request.get(options, function (error, response) {
    if (error) {
      deferred.reject(error);
      return;
    }
    //We expect an OK return code.
    if (response.statusCode !== 200) {
      deferred.reject(new Error(response.statusCode));
      return;
    }
    deferred.resolve(JSON.parse(response.body));
  });

  return deferred.promise;
};

/**
 * Checks if the file exists.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo.
 * @returns {object} A QPromise to a boolean value
 */
ArtifactoryAPI.prototype.fileExists = function (repoKey, remotePath) {
  var deferred = Q.defer(),
    compiled = _.template(ArtifactoryAPI.ACTIONS.filePath),
    actionPath = compiled({
      repoKey : repoKey,
      filePath: remotePath
    }),
    options = {
      url      : this.url_ + actionPath,
      headers  : this._getAuthHeaders(),
      strictSSL: false
    };

  request.head(options, function (error, response) {
    switch (response.statusCode) {
    case 200:
      deferred.resolve(true);
      break;
    case 404:
      deferred.resolve(false);
      break;
    default:
      deferred.reject(response.statusCode);
      break;
    }
  });

  return deferred.promise;
};

/**
 * Uploads a file to artifactory. The uploading file needs to exist!
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo. (in the server)
 * @param   {string} fileToUpload Absolute or relative path to the file to upload
 * @param   {boolean} [forceUpload=false] Flag indicating if the file should be upload if it already exists.
 * @param   {object} checksums
 * @param   {string} checksums.md5
 * @param   {string} checksums.sha1
 * @returns {object} A QPromise to a json object with creation info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-DeployArtifact|DeployArtifact} Artifactory API.
 */
ArtifactoryAPI.prototype.uploadFile = function (repoKey, remotePath, fileToUpload, forceUpload, checksums) {
  var deferred = Q.defer();

  var resolvedFileToUpload = path.resolve(fileToUpload);

  if (!fs.existsSync(resolvedFileToUpload)) {
    deferred.reject(new Error('The file to upload ' + fileToUpload + ' does not exist'));
    return deferred.promise;
  }

  var stream = fs.createReadStream(resolvedFileToUpload);

  return this.uploadStream(repoKey, remotePath, stream, forceUpload, checksums);
};

/**
 * Uploads a file to artifactory. The uploading file needs to exist!
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo. (in the server)
 * @param   {string} streamToUpload The stream to upload
 * @param   {boolean} [forceUpload=false] Flag indicating if the file should be upload if it already exists.
 * @param   {object} checksums
 * @param   {string} checksums.md5
 * @param   {string} checksums.sha1
 * @returns {object} A QPromise to a json object with creation info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-DeployArtifact|DeployArtifact} Artifactory API.
 */
ArtifactoryAPI.prototype.uploadStream = function (repoKey, remotePath, streamToUpload, forceUpload, checksums) {
  var deferred = Q.defer();

  if (!_isStream(streamToUpload)) {
    deferred.reject(new Error("The provided object '" + streamToUpload + "' is not a stream"));
    return deferred.promise;
  }

  var compiled = _.template(ArtifactoryAPI.ACTIONS.filePath),
    actionPath = compiled({
      repoKey : repoKey,
      filePath: remotePath
    }),
    options = {
      url      : this.url_ + actionPath,
      headers  : this. _getAuthHeaders(),
      strictSSL: false
    };

  if (checksums && checksums.sha1) {
    options.headers['X-Checksum-Sha1'] = checksums.sha1;
  } else if (checksums && checksums.md5) {
    options.headers['X-Checksum-Md5'] = checksums.md5;
  }

  //Check if file exists..
  this.fileExists(repoKey, remotePath).then(function (fileExists) {
    if (fileExists && !forceUpload) {
      deferred.reject(new Error('File already exists and forceUpload flag was not provided with a TRUE value.'));
      return;
    }

    streamToUpload.pipe(request.put(options, function (error, response) {
      if (error) {
        deferred.reject(error);
        return;
      }
      //We expect a CREATED return code.
      if (response.statusCode !== 201) {
        deferred.reject(new Error('HTTP Status Code from server was: ' + response.statusCode));
        return;
      }
      deferred.resolve(JSON.parse(response.body));
    }));
  }).fail(function (err) {
    deferred.reject(err);
  });

  return deferred.promise;
};

/** Downloads an artifactory artifact to a specified file path. The folder where the file will be created MUST exist.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo. (in the server)
 * @param   {string} destinationFile Absolute or relative path to the destination file. The folder that will contain the destination file must exist.
 * @param   {boolean} [checkFileIntegrity=false] A flag indicating if a checksum verification should be done as part of the download.
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryAPI.prototype.downloadFile = function (repoKey, remotePath, destinationFile, checkFileIntegrity) {
  var deferred = Q.defer(),
    self = this,
    destinationPath = path.resolve(destinationFile);

  if (!fs.existsSync(path.dirname(destinationPath))) {
    deferred.reject(new Error('The destination folder ' + path.dirname(destinationPath) + ' does not exist.'));
    return deferred.promise;
  }

  try {

    var downloadStream = this.getDownloadStream(repoKey, remotePath);
    downloadStream.pipe(fs.createWriteStream(destinationPath));
    downloadStream.on('finish', function () {
      if (checkFileIntegrity) {
        self.getFileInfo(repoKey, remotePath).then(function (fileInfo) {
          md5File(destinationPath, function (err, sum) {
            if (err) {
              deferred.reject(new Error('Error while calculating MD5: ' + err.toString()));
              return;
            }
            if (sum === fileInfo.checksums.md5) {
              deferred.resolve('Download was SUCCESSFUL even checking expected checksum MD5 (' + fileInfo.checksums.md5 + ')');
            } else {
              deferred.reject(new Error('Error downloading file ' + options.url + '. Checksum (MD5) validation failed. Expected: ' +
                fileInfo.checksums.md5 + ' - Actual downloaded: ' + sum));
            }
          });
        }).fail(function (err) {
          deferred.reject(err);
        });
      } else {
        deferred.resolve('Download was SUCCESSFUL');
      }
    });

  } catch (err) {
    deferred.reject(err);
  }

  return deferred.promise;
};


/** Downloads an artifactory artifact to a specified file path. The folder where the file will be created MUST exist.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo. (in the server)
 * @returns {object} A stream containing the file contents
 */
ArtifactoryAPI.prototype.getDownloadStream = function (repoKey, remotePath) {

  var compiled = _.template(ArtifactoryAPI.ACTIONS.filePath);

  var actionPath = compiled({
    repoKey : repoKey,
    filePath: remotePath
  });

  var options = {
    url      : this.url_ + actionPath,
    headers  : this. _getAuthHeaders(),
    strictSSL: false
  };

  var stream = new nodeStream.Writable();

  var req = request.get(options);
  req.on('response', function (resp) {
    if (resp.statusCode === 200) {
      var pipeResult = req.pipe(stream);
      pipeResult.on('finish', function () {       // not sure if this is needed..
        stream.emit('finish');
      });
    } else {
      throw new Error('Server returned ' + resp.statusCode);
    }
  });

  return stream;
};

/**
 * Deletes a file.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the file inside the repo.
 * @returns {object} A QPromise to a boolean value
 */
ArtifactoryAPI.prototype.deleteFile = function (repoKey, remotePath) {
  var deferred = Q.defer(),
    compiled = _.template(ArtifactoryAPI.ACTIONS.filePath),
    actionPath = compiled({
      repoKey : repoKey,
      filePath: remotePath
    }),
    options = {
      url      : this.url_ + actionPath,
      headers  : this. _getAuthHeaders(),
      strictSSL: false
    };

  request.delete(options, function (error, response) {
    if (error) {
      return deferred.reject(error);
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      deferred.resolve({ success: true, details: response.body });
    } else {
      var err = new Error('Got status code ' + response.statusCode + ' when deleting file: ' + options.url);
      err.statusCode = response.statusCode;
      err.details = response.body;
      deferred.reject(err);
    }
  });

  return deferred.promise;
};

/** Upload Build Information
 * @param   {object} buildInfo - see build.json {@link https://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-BuildUpload} {@link https://github.com/JFrogDev/build-info#build-info-json-format}
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryAPI.prototype.uploadBuild = function (buildInfo) {
  var deferred = Q.defer();
  if(buildInfo.name && _.isString(buildInfo.name)) {
    buildInfo.name = buildInfo.name.trim();
  }

  if(buildInfo.number) {
    if(_.isNumber(buildInfo.number)) {
      buildInfo.number = buildInfo.number.toString();
    } else if(_.isString(buildInfo.number)) {
      buildInfo.number = buildInfo.number.trim();
    }
  }

  if(!buildInfo.name || !buildInfo.number ||
     buildInfo.name.length == 0 || buildInfo.number.length == 0) {

    deferred.reject(new Error('Build Info must include a name and number. See https://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-BuildUpload for more info'));
    return deferred.promise;
  }
  buildInfo.name = buildInfo.name.trim();
  buildInfo.number = buildInfo.number.trim();

  var options = {
    url      : this.url_ + ArtifactoryAPI.API.build,
    headers  : this. _getAuthHeaders(),
    strictSSL: false,
    json     : buildInfo
  };

  request.put(options, function (error, response) {
    if (error) {
      deferred.reject(error.message);
      return;
    }
    //We expect a NO CONTENT return code.
    if (response.statusCode !== 204) {
      deferred.reject(new Error('HTTP Status Code from server was: ' + response.statusCode));
      return;
    }
    deferred.resolve();
  });

  return deferred.promise;
};

ArtifactoryAPI.prototype._getAuthHeaders = function() {
  if (this.auth_ && this.auth_.basic) {
    return {
      'Authorization': 'Basic ' + this.auth_.basic
    };
  } else if (this.auth_ && this.auth_.apiKey) {
    return {
      'X-JFrog-Art-Api': this.auth_.apiKey
    };
  } else {
    throw new Error('Invalid auth object: ' + JSON.stringify(this.auth_));
  }
};


function _isStream(stream) {
	return stream !== null &&
	  typeof stream === 'object' &&
    typeof stream.pipe === 'function';
}

module.exports = ArtifactoryAPI;
