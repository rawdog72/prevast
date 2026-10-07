-- Hooks return intents. The host validates and commits any requested action.
function onTalk(context)
  if context.message == "rumours" then
    return { reply = "Mara sometimes finds rare weapons. Her stock changes with time. Ask her about {trade}." }
  end
end
