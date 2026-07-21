const fs = require('fs');
const files = [
  '__tests__/learn-store.test.js',
  '__tests__/data-consistency.test.js',
  '__tests__/fact-checker.test.js',
  '__tests__/edge-cases.test.js',
  '__tests__/learn-engine.test.js',
];
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  // Add await before store.createPlan( not already preceded by 'await '
  s = s.replace(/(?<!await\s)(store\.createPlan\()/g, 'await $1');
  // Make it/before/after whose body contains store.createPlan async (if not already)
  s = s.replace(/(it|before|after)\(\s*(['"`][^'"`]*['"`]\s*,\s*)(function\s*\(\)|\\(\))\s*(\(|=>\s*\{)/g,
    (m, name, arg, fn, tail) => {
      if (m.includes('async')) return m;
      if (!m.includes('store.createPlan(')) return m;
      return name + '(' + arg + 'async ' + fn + ' ' + tail;
    });
  fs.writeFileSync(f, s);
  console.log('patched', f);
}
