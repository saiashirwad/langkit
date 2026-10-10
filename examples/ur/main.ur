// Explicit polymorphism: checked once, with a rigid A.
fn identity<A>(value: A) -> A = value;

fn greet(person: { name: string }) -> string = person.name;

fn merge<A: Row<Type>, B: Row<Type>>(
  left: Record<A>,
  right: Record<B>
) -> Record<A ++ B>
where disjoint(A, B) = left ++ right;

fn extend<R: Row<Type>>(value: Record<R>) -> Record<R ++ { active: boolean }>
where disjoint(R, { active: boolean }) = merge(value, { active: true });

fn makeAdder(amount: number) -> number -> number =
  fn(value: number) => value + amount;



let ada = merge({ name: "Ada" }, { age: makeAdder(20)(17) });



let main = {
  person: extend(ada),
  greeting: greet({ name: identity("Ada") }),
  answer: identity(42),
  ready: identity(true)
};
