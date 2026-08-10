const HAT = ['hat', 'hats', 'hihat', 'hihats', 'hh'];
const GLUE_MIN = 4;
const has = (tokens: string[], list: string[]) =>
    tokens.some(t =>
      list.some(k => t === k || (k.length >= GLUE_MIN && (t.startsWith(k) || t.endsWith(k))))
    );
console.log(has(['chat'], HAT));
