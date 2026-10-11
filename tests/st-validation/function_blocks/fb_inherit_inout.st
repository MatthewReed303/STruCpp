(* A derived block uses its base's VAR_IN_OUT as its own (IEC 61131-3
   6.6.5.5.2 rule 2): through the in-out, in its body and around SUPER(). *)
TYPE
  IO_SET : STRUCT x : INT; END_STRUCT;
  IO_STS : STRUCT y : BOOL; n : INT; END_STRUCT;
  IO_DATA : STRUCT set : IO_SET; sts : IO_STS; simulate : BOOL; END_STRUCT;
  IO_EXTRA : STRUCT z : INT; END_STRUCT;
END_TYPE

FUNCTION_BLOCK IoBase
  VAR_IN_OUT Data : IO_DATA; END_VAR
  VAR_OUTPUT q : INT; END_VAR
  Data.sts.y := Data.set.x > 0;
  Data.sts.n := Data.sts.n + 1;
  q := Data.set.x;
END_FUNCTION_BLOCK

FUNCTION_BLOCK IoDerived EXTENDS IoBase
  VAR_IN_OUT Extra : IO_EXTRA; END_VAR
  Data.set.x := Extra.z;
  SUPER();
  IF Data.sts.y AND NOT Data.simulate THEN
    Extra.z := Extra.z + 10;
  END_IF;
END_FUNCTION_BLOCK
