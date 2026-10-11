(* Edge inputs BOOL R_EDGE / F_EDGE (IEC 61131-3 6.6.3.2 item 13, Table 44) and
   VAR_TEMP created at each call (6.5.2.1). *)
FUNCTION_BLOCK EdgeFB
  VAR_INPUT
    Start : BOOL R_EDGE;
    Stop : BOOL F_EDGE;
    Plain : BOOL;
  END_VAR
  VAR_OUTPUT
    starts : INT;
    stops : INT;
    sawStart : BOOL;
  END_VAR
  VAR_TEMP
    t : INT;
    t2 : INT := 7;
  END_VAR
  sawStart := Start;
  IF Start THEN starts := starts + 1; END_IF;
  IF Stop THEN stops := stops + 1; END_IF;
  t := t + 1;          (* always 1: a temporary starts at its default each call *)
  t2 := t2 + t;        (* always 8 *)
  IF t <> 1 OR t2 <> 8 THEN starts := -100; END_IF;
END_FUNCTION_BLOCK
