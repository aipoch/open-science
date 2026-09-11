export const rCallbackPlot = `suppressPackageStartupMessages(library(ggplot2))
path <- "inputs/sample-groups-666666666666.csv"
df <- read.csv(path)
counts <- as.data.frame(table(df$group))
names(counts) <- c("group", "n")
total <- sum(counts$n)
percent <- vapply(counts$n, function(x) {
  proportion <- x / total * 100
  round(proportion, 1)
}, numeric(1))
formatter <- function(x, digits=1) sprintf("%.*f%%", digits, x)
counts$percent <- percent
counts$label <- formatter(percent)
write.csv(counts, "counts.csv", row.names=FALSE)
p <- ggplot(counts, aes(group, percent, fill=group)) +
  geom_col() + geom_text(aes(label=label), vjust=-0.5) +
  scale_y_continuous(labels=function(x) sprintf("%s%%", round(x)),
                     expand=expansion(mult=c(0, .1))) +
  theme_minimal()
ggsave("r_callback.png", p, width=6, height=4, dpi=120)
cat("saved r_callback.png\\n")`
