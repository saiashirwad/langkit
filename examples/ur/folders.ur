type Reading: Row<Type> = {
  temperature: number,
  station: string,
  active: boolean
};

type Metadata<A> = {
  label: string,
  show: A -> string
};

fn renderField<A>(
  output: string,
  metadata: Metadata<A>,
  value: A
) -> string =
  textConcat(output, textConcat(metadata.label, textConcat(": ", metadata.show(value))));

fn render<R: Row<Type>>(
  order: Folder<R>,
  metadata: Record<Map<Metadata, R>>,
  values: Record<R>
) -> string =
  foldRecord<Metadata, R, string>(order, metadata, values, "", renderField);

fn main() {
  let values: Record<Reading> = {
    temperature: 22,
    station: "north",
    active: true
  };

  let metadata: Record<Map<Metadata, Reading>> = {
    temperature: {
      label: "Temperature",
      show: fn(value: number) => if value > 20 then "warm; " else "cool; "
    },
    station: {
      label: "Station",
      show: fn(value: string) => textConcat(value, "; ")
    },
    active: {
      label: "Active",
      show: fn(value: boolean) => if value then "yes; " else "no; "
    }
  };

  let order = folder<Reading>(.station, .temperature, .active);
  print(render<Reading>(order, metadata, values));
}
