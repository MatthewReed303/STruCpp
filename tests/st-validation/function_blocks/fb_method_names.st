(* Methods of a block: its own, an inherited one, and prototypes of an interface
   it implements through EXTENDS. A variable cannot share a method's name
   (IEC 61131-3 6.6.5.5.5 rule 2), so the outputs carry their own names. *)
INTERFACE I_A
  METHOD Good : BOOL END_METHOD
END_INTERFACE
INTERFACE I_B EXTENDS I_A
  METHOD Total : LREAL END_METHOD
END_INTERFACE
FUNCTION_BLOCK F IMPLEMENTS I_B
  VAR_OUTPUT IsGood : BOOL; TotalOut : LREAL; OwnOut : INT; END_VAR
  METHOD PUBLIC Good : BOOL Good := TRUE; END_METHOD
  METHOD PUBLIC Total : LREAL Total := 1.0; END_METHOD
  METHOD PUBLIC Own : INT Own := 7; END_METHOD
  IsGood := THIS.Good(); TotalOut := THIS.Total(); OwnOut := THIS.Own();
END_FUNCTION_BLOCK
FUNCTION_BLOCK G EXTENDS F
  VAR_OUTPUT Sum : LREAL; END_VAR
  SUPER();
  Sum := TotalOut + THIS.Total();
END_FUNCTION_BLOCK
