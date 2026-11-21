module.exports = function stage(source) {
  const markup = source.match(/<body>([\s\S]*?)<noscript>/)[1].trim();
  return 'export default ' + JSON.stringify(markup);
};
