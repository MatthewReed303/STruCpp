(* A PROGRAM's VAR_TEMP is created and initialised at each call
   (IEC 61131-3 6.5.2.1): nothing carries over from the previous call. *)
PROGRAM TempCounter
  VAR
    total : INT;
  END_VAR
  VAR_TEMP
    t : INT := 5;
    u : INT;
  END_VAR
  t := t + 1;
  u := u + 2;
  total := total + t + u;
END_PROGRAM
