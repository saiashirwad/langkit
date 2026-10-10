fn identity<A>(value: A) -> A = value;

fn choose<A>(condition: boolean, yes: A, no: A) -> A =
  if condition then yes else no;

fn twice<A>(transform: A -> A, value: A) -> A =
  transform(transform(value));

fn makeCalibration(offset: number) -> number -> number =
  fn(value: number) => value + offset;

fn merge<A: Row<Type>, B: Row<Type>>(
  left: Record<A>,
  right: Record<B>
) -> Record<A ++ B>
where disjoint(A, B) = left ++ right;

fn readValue<R: Row<Type>>(
  reading: Record<{ value: number } ++ R>
) -> number
where disjoint({ value: number }, R) = reading.value;

fn addLabel<A, R: Row<Type>>(
  reading: Record<R>,
  label: A
) -> Record<R ++ { label: A }>
where disjoint(R, { label: A }) = merge(reading, { label: label });

fn markChecked<R: Row<Type>>(
  reading: Record<R>
) -> Record<R ++ { checked: boolean }>
where disjoint(R, { checked: boolean }) = merge(reading, { checked: true });

fn assemble<A: Row<Type>, B: Row<Type>, C: Row<Type>>(
  first: Record<A>,
  second: Record<B>,
  third: Record<C>
) -> Record<A ++ B ++ C>
where disjoint(A, B), disjoint(A ++ B, C) =
  merge(merge(first, second), third);

fn summarize(first: number, second: number) -> {
  average: number,
  difference: number,
  status: string
} =
  let average = (first + second) / 2 in
  let difference = second - first in
  {
    average: average,
    difference: difference,
    status: if average > 20 then "warm" else "cool"
  };

fn unit() -> string = "C";

fn main() {
  let offset = 1;
  let calibrate = makeCalibration(offset);
  let capturedOffset = let offset = 100 in calibrate(20);

  let north: { sensor: string, value: number } =
    { sensor: "north" } ++ { value: identity(19) };
  let south = merge({ sensor: "south", value: 21 }, { indoor: false });

  let northValue = twice(calibrate, readValue(north));
  let southValue = twice(fn(value: number) => value + 1, readValue(south));

  let checkedNorth = markChecked(addLabel(north, "reference"));
  let checkedSouth = markChecked(addLabel(south, { priority: 2, active: true }));
  let summary = summarize(northValue, southValue);

  print(checkedNorth);
  print(checkedSouth);
  print({ north: northValue, south: southValue });
  print(assemble(
    summary,
    { unit: unit() },
    { selected: choose(northValue > southValue, "north", "south") }
  ));
  print({
    capturedOffset: capturedOffset,
    expectedAverage: summary.average == 22,
    identityBoolean: identity(true),
    identityString: identity("ready")
  });
}
