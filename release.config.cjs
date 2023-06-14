// in ".releaserc.js" or "release.config.js"

const { promisify } = require('util')
const dateFormat = require('dateformat')
const readFileAsync = promisify(require('fs').readFile)
const path = require('path')

// the *.hbs template and partials should be passed as strings of contents
const template = readFileAsync(path.join(__dirname, 'release.notes.hbs'))
const commitTemplate = readFileAsync(path.join(__dirname, 'release.commits.hbs'))

module.exports = {
    "branches": [
        "main"
      ],
      "plugins": [
        [
          "semantic-release-gitmoji",
          {
            "releaseRules": {
              "major": [
                ":boom:",
                ":tada:"
              ],
              "minor": [
                ":sparkles:"
              ],
              "patch": [
                ":bug:",
                ":ambulance:",
                ":lock:",
                ":bookmark:"
              ]
            },
            releaseNotes: {
                template,
                partials: { commitTemplate },
                helpers: {
                  datetime: function (format = 'UTC:yyyy-mm-dd') {
                    return dateFormat(new Date(), format)
                  }
                },
                issueResolution: {
                  template: '{baseUrl}/{owner}/{repo}/issues/{ref}',
                  baseUrl: 'https://github.com',
                  source: 'github.com'
                }
              }
          },
        ],
        [
          "@semantic-release/npm",
          {
            "npmPublish": false
          }
        ],
        "@semantic-release/github",
        [
          "@semantic-release/git",
          {
            "assets": [
              "package.json"
            ],
            "message": ":tada: (release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
          }
        ]
      ]
}