// Bucket 2 — multiple void elements left in non-self-closing form
// followed by orphan closers in the wrong order. Each opener must be
// promoted (or the orphan dropped) without losing siblings.
export const DividerList = () => (
  <section>
    <p>Section A</p>
    <br>
    <hr>
    <p>Section B</p>
    </br>
    </hr>
  </section>
);
