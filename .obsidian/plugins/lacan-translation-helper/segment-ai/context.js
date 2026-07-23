const parser = require("./segment-parser");
const resolver = require("./context-resolver");

module.exports = {
  ...parser,
  ...resolver,
};
